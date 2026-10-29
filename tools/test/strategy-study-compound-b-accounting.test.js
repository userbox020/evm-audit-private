"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), ethers = require("ethers");
const capture = require("../strategy-study/capture"), old = require("../strategy-study/call-accounting");
const helper = require("../strategy-study/compound-b-accounting");
const { capturePublicCallBytes, rebuildRawCallTree, analyzePilotCalls, LIMITS, ROLES: R, ABI_REFERENCES } = helper;
const A = "0x1111111111111111111111111111111111111111", CODE = "0x2222222222222222222222222222222222222222";
const PRIVATE = "PRIVATE_RAW_ERROR_SENTINEL", PUBLIC = `0x${Buffer.from("SYNTHETIC_PUBLIC_CALL_PAYLOAD").toString("hex")}`;
const ABI = new ethers.Interface([
  "function buyCollateral(address,uint256,uint256,address)", "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)", "function swap(address,bool,int256,uint160,bytes) returns (int256,int256)",
  "function uniswapV3SwapCallback(int256,int256,bytes)", "function withdraw(uint256)",
  "function flashLoan(address,address[],uint256[],bytes)", "function receiveFlashLoan(address[],uint256[],uint256[],bytes)",
]);
const enc = (name, values) => ABI.encodeFunctionData(name, values).toLowerCase();
const ret = (name, values) => ABI.encodeFunctionResult(name, values).toLowerCase();
const word = value => BigInt(value).toString(16).padStart(64, "0");
const setWord = (input, index, value) => input.slice(0, 10 + index * 64) + word(value) + input.slice(10 + (index + 1) * 64);
function frame(extra = {}) { return { type: "CALL", from: A, to: R.B, gas: "0x100000", gasUsed: "0x1234", value: "0x0", input: "0x", output: "0x", ...extra }; }
function purchase(extra = {}) { return frame({ to: R.M1, input: enc("buyCollateral", [R.W, 13323178823n, 30n, R.B]), ...extra }); }
function run(raw) {
  const frames = capture.normalizeCallTrace(raw), preimages = capturePublicCallBytes(raw, frames);
  return { frames, preimages, result: analyzePilotCalls(frames, preimages) };
}
function decode(raw, index = 0) { return run(raw).result.decodedCalls[index].abiInterpretation; }
function boundFailure(task) {
  assert.throws(task, e => { assert.equal(e.message, "binding-mismatch"); assert.equal(e.cause, undefined); assert.ok(!String(e.stack).includes(PRIVATE)); return true; });
}
function frozen(value) { if (value && typeof value === "object") { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); } }
function pool(callback = {}, extra = {}) {
  return frame({ to: R.P3, from: R.S, input: enc("swap", [R.B, false, -31n, 123456n, PUBLIC]), output: ret("swap", [-31n, 13323178823n]),
    calls: [frame({ from: R.P3, to: R.S, input: enc("uniswapV3SwapCallback", [-31n, 13323178823n, PUBLIC]), ...callback })], ...extra });
}
function financing(callback = {}, extra = {}) {
  return frame({ from: R.B, to: R.V, input: enc("flashLoan", [R.B, [R.U], [30n], PUBLIC]),
    calls: [frame({ from: R.V, to: R.B, input: enc("receiveFlashLoan", [[R.U], [30n], [1n], PUBLIC]), ...callback })], ...extra });
}

test("exact pure API, fixed roles/limits and pinned local/public ABI references are deeply frozen", () => {
  assert.deepEqual(Object.keys(helper).sort(), ["capturePublicCallBytes", "rebuildRawCallTree", "analyzePilotCalls", "LIMITS", "ROLES", "ABI_REFERENCES"].sort());
  assert.deepEqual(LIMITS, { frames: 10000, depth: 256, traceBytes: 8388608, decodeBytes: 65536, assets: 8 });
  assert.deepEqual(Object.keys(R), ["M1", "U", "W", "B", "V", "S", "P3", "Z"]);
  assert.equal(R.M1, "0xc3d688b66703497daa19211eedff47f25384cdc3"); assert.equal(R.P3, "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640");
  frozen(helper);
  for (const [name, reference] of Object.entries(ABI_REFERENCES)) {
    assert.equal(ethers.id(reference.signature).slice(0, 10), ABI.getFunction(name).selector);
    if (reference.path) { assert.match(reference.path, /^targets\/compound-comet-f766f515-provenance-bootstrap\/contracts\//); assert.match(reference.sha256, /^[0-9a-f]{64}$/); }
    else { assert.match(reference.url, /e91a2b643a49856f51a648d175667c1b48cf3377/); assert.equal(Object.hasOwn(reference, "sha256"), false); }
  }
  assert.equal(ABI.getFunction("flashLoan").selector, "0x5c38449e"); assert.equal(ABI.getFunction("receiveFlashLoan").selector, "0xf04f2707");
  assert.equal(ABI.getFunction("balanceOf").selector, "0x70a08231");
});

test("module initializes with only ethers/capture/old accounting imports and no I/O/runtime/collector access", () => {
  const source = fs.readFileSync(path.join(__dirname, "../strategy-study/compound-b-accounting.js"), "utf8"), module = { exports: {} }, imports = [];
  vm.runInNewContext(source, { module, require(name) {
    imports.push(name);
    if (name === "ethers") return ethers;
    if (name === "./capture") return { normalizeCallTrace: capture.normalizeCallTrace, canonical: capture.canonical, sha256: capture.sha256 };
    if (name === "./call-accounting") return { extractCallAccounting: old.extractCallAccounting };
    assert.fail("unexpected dependency");
  } });
  assert.deepEqual(imports, ["ethers", "./capture", "./call-accounting"]);
  assert.deepEqual(Object.keys(module.exports).sort(), Object.keys(helper).sort());
});

test("public preimages are canonical ordered exact rows, bind hashes and never retain raw errors/extras", () => {
  const raw = frame({ input: PUBLIC.toUpperCase(), output: undefined, error: PRIVATE, revertReason: PRIVATE,
    calls: [purchase({ output: PUBLIC }), frame({ input: "0x1234", output: "0x5678" })] });
  const frames = capture.normalizeCallTrace(raw), before = structuredClone({ raw, frames });
  const preimages = capturePublicCallBytes(raw, frames), rebuilt = rebuildRawCallTree(frames, preimages);
  assert.deepEqual(preimages, [{ frameIndex: 0, input: PUBLIC, output: "0x" }, { frameIndex: 1, input: raw.calls[0].input, output: PUBLIC }, { frameIndex: 2, input: "0x1234", output: "0x5678" }]);
  assert.equal(rebuilt.error, "reverted"); assert.equal(rebuilt.revertReason, undefined);
  assert.equal(rebuilt.output, "0x"); assert.deepEqual(capture.normalizeCallTrace(rebuilt), frames);
  assert.ok(!JSON.stringify({ preimages, rebuilt }).includes(PRIVATE));
  assert.deepEqual({ raw, frames }, before); assert.equal(Object.isFrozen(raw), false); assert.equal(Object.isFrozen(frames), false);
  frozen(preimages); frozen(rebuilt);
  boundFailure(() => capturePublicCallBytes({ ...raw, rawExtra: PRIVATE }, frames));
});

test("original log metadata, optional indexes, positions, rollback and preorder survive exact reconstruction", () => {
  const log = (position, extra = {}) => ({ address: R.U, topics: [`0x${word(1)}`], data: `0x${word(30)}`, position, ...extra });
  const raw = frame({ logs: [log(0, { index: "0x1eb" }), log(2)], calls: [frame({ error: PRIVATE, calls: [frame({ logs: [log(0, { index: "0xffffffffffffffff" })] })] }),
    frame({ logs: [log(0, { index: "0x0" })] })] });
  const { frames, preimages } = run(raw), rebuilt = rebuildRawCallTree(frames, preimages);
  assert.deepEqual(capture.normalizeCallTrace(rebuilt), frames);
  assert.deepEqual(frames.map(f => [f.index, f.parent, f.depth, f.committed]), [[0, null, 0, true], [1, 0, 1, false], [2, 1, 2, false], [3, 0, 1, true]]);
  assert.equal(rebuilt.logs[0].index, "0x1eb"); assert.equal(Object.hasOwn(rebuilt.logs[1], "index"), false);
  assert.equal(rebuilt.calls[0].calls[0].logs[0].index, "0xffffffffffffffff");
  assert.equal(rebuilt.logs[1].position, "0x2");
});

test("strict preimage count/index/keys/hex/hash binding rejects mutations, getters and serializer tricks", () => {
  const { frames, preimages } = run(frame({ input: PUBLIC, calls: [purchase()] }));
  for (const mutate of [p => p.pop(), p => p.push(p[0]), p => p.reverse(), p => { p[1].frameIndex = "1"; }, p => { p[0].extra = PRIVATE; },
    p => { p[0].input = "0x00"; }, p => { p[1].output = "0x00"; }, p => { p[0].input = PUBLIC.toUpperCase(); }, p => { p[0].input = "0x0"; },
    p => { p[0].output = null; }, p => { delete p[0].output; }, p => { Object.defineProperty(p[0], "input", { get() { throw new Error(PRIVATE); } }); },
    p => { Object.defineProperty(p[0], "toJSON", { value() { throw new Error(PRIVATE); } }); }, p => { p[0][Symbol("x")] = PRIVATE; }]) {
    const changed = structuredClone(preimages); mutate(changed);
    boundFailure(() => rebuildRawCallTree(frames, changed)); boundFailure(() => analyzePilotCalls(frames, changed));
  }
});

test("normalized frame keys, decimal scalars, topology, commitments and hashes cannot be repaired", () => {
  const raw = frame({ calls: [frame({ calls: [purchase()] }), frame()] }), { frames, preimages } = run(raw);
  const changes = [f => f.pop(), f => f.push(f[1]), f => { f[2].parent = 3; }, f => { f[3].parent = 1; }, f => { f[3].depth = 2; },
    f => { f[1].depth = 2; }, f => { f[0].parent = 0; }, f => { f[1].index = 2; }, f => { f[1].error = 1; }, f => { f[1].committed = false; },
    f => { f[0].extra = PRIVATE; }, f => { delete f[0].gas; }, f => { f[0].value = "00"; }, f => { f[0].gasUsed = "0x1234"; },
    f => { f[0].value = (1n << 256n).toString(); }, f => { f[0].from = "0x1"; }, f => { f[0].to = null; }, f => { f[0].type = "STOP"; },
    f => { f[0].inputSha256 = "0".repeat(64); }, f => { f[1].outputSha256 = "not-a-hash"; }, f => { f[0].logs = [f[0]]; }];
  for (const mutate of changes) {
    const changed = structuredClone(frames); mutate(changed);
    boundFailure(() => capturePublicCallBytes(raw, changed)); boundFailure(() => rebuildRawCallTree(changed, preimages));
  }
  // Scalar changes can describe a different valid tree, but cannot bind the original raw observation.
  for (const mutate of [f => { f[1].gasUsed = "1"; }, f => { f[1].from = CODE; }, f => { f[1].type = "STATICCALL"; }]) {
    const changed = structuredClone(frames); mutate(changed); boundFailure(() => capturePublicCallBytes(raw, changed));
  }
});

test("cyclic/shared raw nodes, bad bytes, getters and mismatched raw/normalized trees fail with only a fixed code", () => {
  const raw = frame({ calls: [purchase()] }), frames = capture.normalizeCallTrace(raw);
  for (const mutate of [r => { r.calls[0].calls = [r]; }, r => { r.calls.push(r.calls[0]); }, r => { r.calls = null; }, r => { r.calls[0].input = "0x00"; },
    r => { r.input = null; }, r => { r.output = "bad"; }, r => { r.calls[0].type = "STATICCALL"; }, r => { r.logs = [{ topics: null }]; },
    r => { Object.defineProperty(r, "error", { enumerable: true, get() { throw new Error(PRIVATE); } }); }]) {
    const changed = structuredClone(raw); mutate(changed); boundFailure(() => capturePublicCallBytes(changed, frames));
  }
});

test("empty/over-cap frames and depth overflow are bounded before normalization; exact depth limit works", () => {
  let raw = frame(); for (let i = 0; i < LIMITS.depth; i++) raw = frame({ calls: [raw] });
  const { frames, preimages } = run(raw); assert.equal(frames.length, 257); assert.deepEqual(capture.normalizeCallTrace(rebuildRawCallTree(frames, preimages)), frames);
  const hypothetical = structuredClone(frames); hypothetical.push({ ...hypothetical.at(-1), index: 257, parent: 256, depth: 257 });
  boundFailure(() => capturePublicCallBytes(frame({ calls: [raw] }), hypothetical));
  boundFailure(() => rebuildRawCallTree(hypothetical, [...preimages, { frameIndex: 257, input: "0x", output: "0x" }]));
  for (const bad of [[], Array(10001).fill(frames[0]), Array(2)]) boundFailure(() => capturePublicCallBytes(frame(), bad));
});

test("10000-frame boundary and aggregate 8MiB public-byte boundary preserve full data; excess fails instead of trimming", () => {
  const raw = frame({ calls: Array.from({ length: 9999 }, () => frame()) });
  const frames = capture.normalizeCallTrace(raw), preimages = capturePublicCallBytes(raw, frames);
  assert.equal(preimages.length, 10000); assert.equal(rebuildRawCallTree(frames, preimages).calls.length, 9999);
  const data = `0x${"ab".repeat(128 * 1024)}`, large = frame({ input: data, calls: Array.from({ length: 63 }, () => frame({ input: data })) });
  const normalized = capture.normalizeCallTrace(large), bytes = capturePublicCallBytes(large, normalized);
  assert.equal(bytes.reduce((n, p) => n + (p.input.length + p.output.length - 4) / 2, 0), LIMITS.traceBytes);
  assert.equal(rebuildRawCallTree(normalized, bytes).calls.length, 63);
  const excess = structuredClone(large); excess.output = "0x00";
  boundFailure(() => capturePublicCallBytes(excess, capture.normalizeCallTrace(excess)));
  boundFailure(() => rebuildRawCallTree(capture.normalizeCallTrace(excess), bytes.map((p, i) => i ? p : { ...p, output: "0x00" })));
});

test("analysis top-level shape is exact and base accounting is the unchanged fixed-M1 legacy adapter", () => {
  const raw = frame({ calls: [purchase(), frame({ to: R.U, input: enc("transfer", [R.Z, 1n]), output: ret("transfer", [true]) })] });
  const { frames, preimages, result } = run(raw);
  assert.deepEqual(Object.keys(result), ["baseAccounting", "decodedCalls", "nativeEffects"]);
  assert.deepEqual(result.baseAccounting, old.extractCallAccounting(rebuildRawCallTree(frames, preimages), frames, { compoundEmitters: [R.M1], morphoEmitters: [] }));
  assert.equal(result.decodedCalls.length, frames.length); frozen(result);
  assert.equal(result.baseAccounting[2].abiInterpretation.reason, "unqualified-target"); assert.equal(result.decodedCalls[2].abiInterpretation.function, "transfer");
});

test("synthetic purchase arguments retain recipient/minimum/requested amount, not measured receipt proceeds or fees", () => {
  const raw = purchase({ input: enc("buyCollateral", [R.W, 13323178823n, 31n, R.Z]) }), { result } = run(raw), a = result.decodedCalls[0].abiInterpretation;
  assert.deepEqual(a.arguments, { asset: R.W, minAmount: "13323178823", baseAmount: "31", recipient: R.Z });
  assert.deepEqual(a.returns, { status: "void", reason: null, result: null });
  assert.notEqual(a.arguments.baseAmount, "30"); // Synthetic request != B's reported measured receipt amount; no repair.
  assert.deepEqual(result.nativeEffects, { transfers: [], unresolved: [] });
  assert.ok(!/2147619289190128|profit|netProfit|measuredAmount|feeWei/.test(JSON.stringify(result)));
  assert.equal(a.sourceRuntimeVerified, false); assert.equal(a.balancesVerified, false);
});

test("role+selector dispatch is mandatory, optional routers/custom selectors and initcode stay unknown", () => {
  for (const [raw, reason] of [[frame({ input: "0x123456" }), "no-selector"], [purchase({ to: A }), "unqualified-target"],
    [frame({ to: R.U, input: enc("buyCollateral", [R.W, 0n, 30n, R.B]) }), "unsupported-selector"],
    ...["0x414bf389", "0xdb3e2198", "0xc04b8d59", "0xf28c0498"].map(input => [frame({ to: R.S, input }), "unsupported-selector"]),
    [frame({ to: R.B, input: "0xdeadbeef" }), "unsupported-selector"], [purchase({ type: "CREATE" }), "non-message-call"],
    [frame({ type: "SELFDESTRUCT", from: R.U, to: R.Z, input: enc("transfer", [R.Z, 1n]) }), "non-message-call"]]) {
    const a = decode(raw); assert.equal(a.status, "unknown"); assert.equal(a.reason, reason); assert.equal(a.arguments, null);
  }
});

test("U/W transfer/transferFrom/approve preserve exact uints and canonical true/false; empty is never true", () => {
  for (const to of [R.U, R.W]) for (const [name, args, expected] of [["transfer", [R.Z, 1n], { to: R.Z, amount: "1" }],
    ["transferFrom", [R.B, R.M1, 30n], { from: R.B, to: R.M1, amount: "30" }], ["approve", [R.V, (1n << 256n) - 1n], { spender: R.V, amount: ((1n << 256n) - 1n).toString() }]]) {
    for (const value of [true, false]) {
      const a = decode(frame({ to, input: enc(name, args), output: ret(name, [value]) }));
      assert.deepEqual(a.arguments, expected); assert.deepEqual(a.returns, { status: "decoded", reason: null, result: { value } });
    }
    for (const output of ["0x", `0x${word(2)}`, `0x${word(1)}00`, "0x01"]) {
      const a = decode(frame({ to, input: enc(name, args), output }));
      assert.equal(a.status, "decoded"); assert.deepEqual(a.returns, { status: "unknown", reason: "invalid-return-data", result: null });
    }
  }
});

test("balanceOf uint returns are positional observations, not transaction-boundary balances or inferred zero", () => {
  const raw = frame({ calls: [frame({ type: "STATICCALL", to: R.U, input: enc("balanceOf", [R.B]), output: ret("balanceOf", [100n]) }),
    frame({ to: R.U, input: enc("transfer", [R.M1, 30n]), output: ret("transfer", [true]) }),
    frame({ type: "STATICCALL", to: R.U, input: enc("balanceOf", [R.B]), output: ret("balanceOf", [70n]) }),
    frame({ type: "STATICCALL", to: R.W, input: enc("balanceOf", [R.B]), output: "0x" })] });
  const rows = run(raw).result.decodedCalls;
  assert.deepEqual(rows.filter(r => r.abiInterpretation.function === "balanceOf").map(r => [r.frameIndex, r.abiInterpretation.arguments.account, r.abiInterpretation.returns.result]),
    [[1, R.B, { balance: "100" }], [3, R.B, { balance: "70" }], [4, R.B, null]]);
  assert.ok(rows.every(r => r.abiInterpretation.balancesVerified === false));
  const a = decode(frame({ to: R.U, input: enc("balanceOf", [R.B]), output: ret("balanceOf", [(1n << 256n) - 1n]) }));
  assert.equal(a.returns.result.balance, ((1n << 256n) - 1n).toString());
});

test("synthetic pool signed (-31,13323178823) return and callback deltas preserve source-compatible direction and payload length only", () => {
  const { result, preimages } = run(pool()), [swap, callback] = result.decodedCalls.map(r => r.abiInterpretation);
  assert.deepEqual(swap.arguments, { recipient: R.B, zeroForOne: false, amountSpecified: "-31", sqrtPriceLimitX96: "123456", dataBytes: (PUBLIC.length - 2) / 2 });
  assert.deepEqual(swap.returns.result, { amount0: "-31", amount1: "13323178823" });
  assert.deepEqual(callback.arguments, { amount0Delta: "-31", amount1Delta: "13323178823", dataBytes: (PUBLIC.length - 2) / 2 });
  assert.equal(callback.returns.status, "void"); assert.ok(preimages[0].input.includes(PUBLIC.slice(2)));
  assert.ok(!JSON.stringify(result).includes(PUBLIC.slice(2))); assert.ok(!/token0|token1|price|profit/.test(JSON.stringify(result)));
});

test("swap callback requires relevant pool/initiator context, including delegated callback frames", () => {
  for (const raw of [frame({ to: R.S, input: enc("uniswapV3SwapCallback", [1n, -1n, "0x"]) }), pool({ from: A }), pool({}, { from: A }),
    pool({}, { to: A }), pool({}, { input: "0xdeadbeef" })]) {
    const rows = run(raw).result.decodedCalls, a = rows.at(-1).abiInterpretation;
    assert.equal(a.reason, "unmatched-callback-context"); assert.equal(a.arguments, null);
  }
  const input = enc("uniswapV3SwapCallback", [-31n, 13323178823n, "0x"]);
  const raw = pool({ input, calls: [frame({ type: "DELEGATECALL", from: R.S, to: CODE, input })] });
  const rows = run(raw).result.decodedCalls;
  assert.equal(rows[2].executionAddress, R.S); assert.equal(rows[2].codeAddress, CODE); assert.equal(rows[2].abiInterpretation.status, "decoded");
});

test("Balancer financing declarations decode bounded arrays and distinct principal/fee parameters with no repayment/profit inference", () => {
  const { result } = run(financing()), [loan, callback] = result.decodedCalls.map(r => r.abiInterpretation);
  assert.deepEqual(loan.arguments, { recipient: R.B, tokens: [R.U], amounts: ["30"], userDataBytes: (PUBLIC.length - 2) / 2 });
  assert.deepEqual(callback.arguments, { tokens: [R.U], amounts: ["30"], feeAmounts: ["1"], userDataBytes: (PUBLIC.length - 2) / 2 });
  assert.equal(Object.hasOwn(callback.arguments, "recipient"), false);
  assert.equal(loan.returns.status, "void"); assert.equal(callback.returns.status, "void");
  assert.deepEqual(loan.protocolMatch, { status: "matched", reason: "array-parameters-only" });
  assert.deepEqual(callback.protocolMatch, loan.protocolMatch);
  assert.deepEqual(result.nativeEffects, { transfers: [], unresolved: [] });
  assert.ok(!/repaymentProved|obligationComplete|profit/.test(JSON.stringify(result)));
});

test("financing callback requires relevant Vault recipient context and follows proxy execution rather than nominal code", () => {
  for (const raw of [frame({ to: R.B, input: enc("receiveFlashLoan", [[R.U], [30n], [1n], "0x"]) }), financing({ from: A }), financing({}, { to: A }),
    financing({}, { input: enc("flashLoan", [R.Z, [R.U], [30n], "0x"]) })]) assert.equal(run(raw).result.decodedCalls.at(-1).abiInterpretation.reason, "unmatched-callback-context");
  const input = enc("receiveFlashLoan", [[R.U], [30n], [1n], "0x"]);
  const raw = financing({ input, calls: [frame({ type: "DELEGATECALL", from: R.B, to: CODE, input })] });
  const a = run(raw).result.decodedCalls[2]; assert.equal(a.executionAddress, R.B); assert.equal(a.codeAddress, CODE); assert.equal(a.abiInterpretation.status, "decoded");
});

test("ABI-valid financing array mismatches stay explicit unmatched observations, never truncated/repaired", () => {
  const loans = [enc("flashLoan", [R.B, [R.U, R.W], [30n], "0x"]), enc("flashLoan", [R.B, [R.U], [], "0x"])];
  for (const input of loans) {
    const a = decode(frame({ to: R.V, input })); assert.equal(a.status, "decoded");
    assert.deepEqual(a.protocolMatch, { status: "unmatched", reason: "array-length-mismatch" });
    assert.notEqual(a.arguments.tokens.length, a.arguments.amounts.length);
  }
  for (const input of [enc("receiveFlashLoan", [[R.U], [30n], [], "0x"]), enc("receiveFlashLoan", [[R.U, R.W], [30n], [1n], "0x"])]) {
    const a = run(financing({ input })).result.decodedCalls[1].abiInterpretation;
    assert.equal(a.status, "decoded"); assert.equal(a.protocolMatch.reason, "array-length-mismatch");
  }
  const changed = run(financing({ input: enc("receiveFlashLoan", [[R.W], [31n], [1n], "0x"]) })).result.decodedCalls[1].abiInterpretation;
  assert.deepEqual(changed.protocolMatch, { status: "unmatched", reason: "parent-parameters-mismatch" });
});

test("eight-asset cap applies before array allocation; exactly eight survives without truncation", () => {
  for (const n of [8, 9]) {
    const tokens = Array(n).fill(R.U), amounts = Array(n).fill(30n), fees = Array(n).fill(1n);
    const raw = financing({ input: enc("receiveFlashLoan", [tokens, amounts, fees, "0x"]) }, { input: enc("flashLoan", [R.B, tokens, amounts, "0x"]) });
    const rows = run(raw).result.decodedCalls;
    assert.equal(rows[0].abiInterpretation.status, n === 8 ? "decoded" : "unknown");
    if (n === 8) { assert.equal(rows[1].abiInterpretation.arguments.tokens.length, 8); assert.equal(rows[1].abiInterpretation.arguments.feeAmounts.length, 8); }
    else assert.equal(rows[0].abiInterpretation.reason, "asset-limit-exceeded");
  }
  const valid = enc("flashLoan", [R.B, [R.U], [30n], "0x"]);
  const hugeCount = setWord(valid, 4, (1n << 256n) - 1n);
  assert.equal(decode(frame({ to: R.V, input: hugeCount })).reason, "asset-limit-exceeded");
});

test("dynamic offsets, counts, ordering, byte padding and exact re-encoding reject noncanonical ABI as unknown, not broken evidence", () => {
  const swap = enc("swap", [R.B, true, 31n, 123n, "0x12"]), loan = enc("flashLoan", [R.B, [R.U], [30n], "0x12"]);
  const values = [[R.P3, setWord(swap, 4, (1n << 256n) - 1n)], [R.P3, setWord(swap, 4, 0)], [R.P3, setWord(swap, 4, 192)],
    [R.P3, setWord(swap, 5, (1n << 256n) - 1n)], [R.P3, swap.slice(0, -2) + "01"], [R.P3, swap + word(0)],
    [R.P3, setWord(swap, 1, 2)], [R.P3, setWord(swap, 3, 1n << 160n)], [R.P3, setWord(swap, 0, 1n << 200n)],
    [R.V, setWord(loan, 2, 128)], [R.V, setWord(loan, 3, 160)], [R.V, loan.slice(0, -2)], [R.V, loan + "00"]];
  for (const [to, input] of values) {
    const { result, preimages } = run(frame({ to, input })); const a = result.decodedCalls[0].abiInterpretation;
    assert.equal(a.status, "unknown"); assert.equal(a.reason, "invalid-calldata"); assert.equal(a.arguments, null); assert.equal(preimages[0].input, input);
  }
});

test("fixed calldata lengths and canonical addresses/uint encodings are exact; trailing bytes never partially decode", () => {
  for (const [to, input] of [[R.M1, purchase().input], [R.U, enc("transfer", [R.Z, 1n])], [R.W, enc("withdraw", [13n])], [R.U, enc("balanceOf", [R.B])]]) {
    for (const value of [input.slice(0, -2), input + "00", input + word(0)]) {
      const a = decode(frame({ to, input: value })); assert.equal(a.status, "unknown"); assert.equal(a.reason, "invalid-calldata");
    }
  }
  assert.equal(decode(purchase({ input: setWord(purchase().input, 0, 1n << 200n) })).reason, "invalid-calldata");
});

test("64KiB decode cap bounds input and combined return decoding while public-byte evidence remains intact", () => {
  const large = `0x${"ab".repeat(65344)}`, input = enc("swap", [R.B, false, -31n, 1n, large]);
  const { result, preimages } = run(frame({ to: R.P3, input }));
  assert.ok((input.length - 2) / 2 > LIMITS.decodeBytes); assert.equal(preimages[0].input, input);
  assert.equal(result.decodedCalls[0].abiInterpretation.reason, "decode-limit-exceeded"); assert.equal(result.decodedCalls[0].abiInterpretation.arguments, null);
  const near = enc("swap", [R.B, false, -31n, 1n, `0x${"ab".repeat(65312)}`]);
  const a = decode(frame({ to: R.P3, input: near, output: ret("swap", [-31n, 13323178823n]) }));
  assert.equal(a.status, "decoded"); assert.equal(a.arguments.dataBytes, 65312); assert.equal(a.returns.reason, "decode-limit-exceeded");
});

test("void, signed and uint outputs require their exact roundtrip and size", () => {
  for (const raw of [purchase({ output: "0x00" }), frame({ to: R.W, input: enc("withdraw", [13n]), output: `0x${word(0)}` }), financing({}, { output: "0x01" })]) {
    const a = decode(raw); assert.equal(a.status, "decoded"); assert.equal(a.returns.reason, "unexpected-return-data");
  }
  for (const output of ["0x", `0x${word(0)}`, ret("swap", [-31n, 13323178823n]) + "00"]) assert.equal(decode(pool({}, { output })).returns.reason, "invalid-return-data");
  const extremes = decode(pool({}, { output: ret("swap", [-(1n << 255n), (1n << 255n) - 1n]) }));
  assert.deepEqual(extremes.returns.result, { amount0: (-(1n << 255n)).toString(), amount1: ((1n << 255n) - 1n).toString() });
  for (const output of ["0x", `0x${word(1)}00`, `0x${word(1)}${word(2)}`]) assert.equal(decode(frame({ to: R.U, input: enc("balanceOf", [R.B]), output })).returns.reason, "invalid-return-data");
});

test("reverted/ancestor-reverted returns are unknown even when ABI bytes are canonical; caught siblings remain committed", () => {
  const child = frame({ to: R.U, input: enc("transfer", [R.Z, 1n]), output: ret("transfer", [true]), value: "0x5" });
  const raw = frame({ calls: [frame({ error: PRIVATE, calls: [child, pool(), financing()] }), structuredClone(child)] });
  const { result } = run(raw), rows = result.decodedCalls;
  assert.equal(rows[2].abiInterpretation.status, "decoded"); assert.equal(rows[2].abiInterpretation.returns.reason, "ancestor-reverted");
  assert.equal(rows[3].abiInterpretation.returns.reason, "ancestor-reverted"); assert.equal(rows[4].abiInterpretation.returns.reason, "ancestor-reverted");
  assert.equal(rows[5].abiInterpretation.returns.reason, "ancestor-reverted"); assert.equal(rows[6].abiInterpretation.returns.reason, "ancestor-reverted");
  assert.equal(rows[7].abiInterpretation.returns.status, "decoded"); assert.deepEqual(result.nativeEffects.transfers.map(t => t.frameIndex), [7]);
  assert.equal(decode({ ...child, error: PRIVATE }).returns.reason, "reverted"); assert.ok(!JSON.stringify(result).includes(PRIVATE));
});

test("proxy duplicate inputs stay separate context observations, never duplicate native transfers or qualify by code address", () => {
  const raw = purchase({ value: "0x1", calls: [frame({ type: "DELEGATECALL", from: R.M1, to: CODE, input: purchase().input, value: "0x1",
    calls: [frame({ type: "CALLCODE", from: R.M1, to: A, input: purchase().input, value: "0x1" })] })] });
  const { result } = run(raw), rows = result.decodedCalls;
  assert.deepEqual(rows.map(r => r.executionAddress), [R.M1, R.M1, R.M1]); assert.deepEqual(rows.map(r => r.codeAddress), [R.M1, CODE, A]);
  assert.ok(rows.every(r => r.abiInterpretation.function === "buyCollateral")); assert.deepEqual(result.nativeEffects.transfers.map(t => t.frameIndex), [0]);
  const unqualified = run(frame({ to: A, calls: [frame({ type: "DELEGATECALL", to: R.M1, input: purchase().input })] })).result.decodedCalls[1];
  assert.equal(unqualified.executionAddress, A); assert.equal(unqualified.codeAddress, R.M1); assert.equal(unqualified.abiInterpretation.reason, "unqualified-target");
});

test("native root/CALL/CREATE/CREATE2 count once, zero/STATICCALL/CALLCODE/DELEGATECALL and rolled-back values never count", () => {
  const raw = frame({ value: "0x1", calls: [frame({ value: "0x2" }), frame({ type: "CREATE", to: CODE, value: "0x3" }),
    frame({ type: "CREATE2", to: CODE, value: "0x4" }), frame({ type: "STATICCALL", value: "0x5" }), frame({ type: "CALLCODE", value: "0x6" }),
    frame({ type: "DELEGATECALL", value: "0x7" }), frame({ error: PRIVATE, value: "0x8", calls: [frame({ value: "0x9" })] }), frame()] });
  const effects = run(raw).result.nativeEffects;
  assert.deepEqual(effects.transfers.map(t => [t.frameIndex, t.parent, t.type, t.valueWei]), [[0, null, "CALL", "1"], [1, 0, "CALL", "2"], [2, 0, "CREATE", "3"], [3, 0, "CREATE2", "4"]]);
  assert.ok(effects.transfers.every(t => t.from === A && !t.sourceRuntimeVerified && !t.balancesVerified)); assert.deepEqual(effects.unresolved, []);
});

test("SELFDESTRUCT remains explicit unresolved without deletion/value inference; failed CREATE null recipient roundtrips", () => {
  const raw = frame({ calls: [frame({ type: "SELFDESTRUCT", from: R.B, to: R.Z, value: "0x123" }), frame({ type: "CREATE", to: null, value: "0x99", error: PRIVATE }),
    frame({ error: PRIVATE, calls: [frame({ type: "SELFDESTRUCT", from: R.B, to: R.Z, value: "0x456" })] })] });
  const { frames, preimages, result } = run(raw);
  assert.deepEqual(result.nativeEffects.transfers, []); assert.equal(result.nativeEffects.unresolved.length, 1);
  assert.deepEqual(result.nativeEffects.unresolved[0], { frameIndex: 1, parent: 0, type: "SELFDESTRUCT", from: R.B, to: R.Z, reason: "selfdestruct-effects-unresolved", sourceRuntimeVerified: false, balancesVerified: false });
  assert.deepEqual(capture.normalizeCallTrace(rebuildRawCallTree(frames, preimages)), frames);
  assert.ok(!/deleted|profit|valueWei/.test(JSON.stringify(result.nativeEffects)));
});

test("W withdraw is source-compatible conversion input; its native child is observed once, not a second expense", () => {
  const raw = frame({ to: R.W, input: enc("withdraw", [13n]), calls: [frame({ from: R.W, to: R.B, value: "0xd" })] });
  const { result } = run(raw); assert.deepEqual(result.decodedCalls[0].abiInterpretation.arguments, { wad: "13" });
  assert.equal(result.decodedCalls[0].abiInterpretation.returns.status, "void"); assert.equal(result.nativeEffects.transfers.length, 1);
  assert.equal(result.nativeEffects.transfers[0].valueWei, "13"); assert.equal(result.nativeEffects.transfers[0].frameIndex, 1);
});

test("synthetic 30/31/1 token calls are observations only; no token/native/fee double counting or payload/error leakage", () => {
  const transfer = (from, to, amount) => frame({ from, to: R.U, input: enc("transfer", [to, amount]), output: ret("transfer", [true]) });
  const raw = frame({ input: PUBLIC, calls: [transfer(R.V, R.B, 30n), purchase(), transfer(R.P3, R.B, 31n), transfer(R.B, R.Z, 1n), transfer(R.B, R.V, 30n),
    pool({ revertReason: PRIVATE }), financing()] });
  const { frames, preimages, result } = run(raw), text = JSON.stringify(result);
  assert.equal(result.decodedCalls.length, frames.length); assert.deepEqual(result.nativeEffects.transfers, []);
  assert.ok(preimages[0].input.includes(PUBLIC.slice(2))); assert.ok(!text.includes(PUBLIC.slice(2))); assert.ok(!text.includes(PRIVATE));
  assert.ok(!text.includes(capture.sha256(Buffer.from(PUBLIC.slice(2), "hex"))));
  assert.ok(!/netProfit|profitKnown|amountReceived|repaymentComplete|gasFee/.test(text));
  assert.deepEqual(result.decodedCalls.filter(r => r.abiInterpretation.function === "transfer").map(r => r.abiInterpretation.arguments.amount), ["30", "31", "1", "30"]);
});
