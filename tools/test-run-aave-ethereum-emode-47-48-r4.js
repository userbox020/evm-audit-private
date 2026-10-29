#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const r4 = require("./run-aave-ethereum-emode-47-48-r4.js");
const pf = require("./lib/common-finalized-rpc-preflight.js");

let tests = 0;
const test = async (name, fn) => { await fn(); tests += 1; process.stdout.write(`ok ${tests} - ${name}\n`); };
const header = Object.freeze({ number: `0x${r4.PIN.number.toString(16)}`, hash: r4.PIN.hash, parentHash: r4.PIN.parentHash, stateRoot: r4.PIN.stateRoot, timestamp: `0x${BigInt(r4.PIN.timestamp).toString(16)}` });
const finalized = Object.freeze({ ...header, number: `0x${(r4.PIN.number + 100).toString(16)}` });
const slot = `0x${"0".repeat(24)}${r4.A.hubImplementation.slice(2)}`;
const metadata = `a2646970667358221220${"12".repeat(32)}64736f6c634300081b`;
const bytecode = (body) => `${body}fe${metadata}0033`;
const candidates = pf.REVIEWED_OPERATOR_FAMILY_IDS.map((operatorFamily, handle) => ({ handle, operatorFamily }));
const pair = candidates.slice(0, 2);
const productionBefore = [r4.OUTPUT, r4.ATTEMPT].map((file) => fs.existsSync(path.join(r4.ROOT, file)) ? r4.sha256(fs.readFileSync(path.join(r4.ROOT, file))) : null);
const codes = Object.freeze({
  [r4.A.hub]: bytecode("0x6001600055"),
  [r4.A.hubImplementation]: bytecode("0x6002600055"),
  [r4.A.agent]: bytecode("0x6003600055"),
  [r4.A.range]: bytecode("0x6004600055")
});
const viewResults = new Map(r4.AGENT_VIEWS.map((view) => [view.data, view.iface.encodeFunctionResult(view.fn, [view.expected])]));
function transport(overrides = {}) {
  return async (_handle, method, params) => {
    if (overrides[method]) return overrides[method](params);
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return params[0] === "finalized" ? finalized : header;
    if (method === "eth_getStorageAt") return slot;
    if (method === "eth_getCode") return codes[params[0]];
    if (method === "eth_call") return viewResults.get(params[0].data);
    throw new Error("unexpected method");
  };
}
function syntheticAuthority() {
  const actual = r4.readAuthority();
  const r3 = structuredClone(actual.r3);
  for (const [key, target] of Object.entries({ hub: r4.A.hub, agent: r4.A.agent, range: r4.A.range })) {
    r3.report.observations.current.code[key] = { address: target, ...r4.codeIdentity(codes[target]) };
  }
  return { ...actual, r3, hubBuild: { ...actual.hubBuild, runtime: codes[r4.A.hubImplementation], identity: r4.codeIdentity(codes[r4.A.hubImplementation]) },
    rangeBuild: { ...actual.rangeBuild, runtime: codes[r4.A.range], identity: r4.codeIdentity(codes[r4.A.range]) } };
}
function fakeRequest(respond) {
  return (_options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (body) => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 200;
      callback(res); respond(res, JSON.parse(body.toString("utf8")));
    });
    return req;
  };
}
async function temporaryRun(fn) {
  const root = fs.mkdtempSync("C:/Users/MiPC/AppData/Local/Temp/opencode/emode-r4-test-");
  fs.mkdirSync(path.join(root, "reports/raw/fast"), { recursive: true });
  try { await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

(async () => {
  await test("pinned source and artifacts pass offline", () => {
    const authority = r4.readAuthority();
    assert.equal(authority.hubBuild.compiler, "0.8.27+commit.40a35a09");
    assert.equal(authority.rangeBuild.evmVersion, "shanghai");
  });
  await test("metadata stripping preserves executable body", () => {
    assert.equal(r4.stripMetadata(bytecode("0x6001600055")), "0x6001600055fe");
    assert.throws(() => r4.stripMetadata("0x00"), /BYTECODE_INVALID/);
    assert.throws(() => r4.stripMetadata("0x6001600055a16474657374010007"), /BYTECODE_INVALID/);
    assert.throws(() => r4.stripMetadata(bytecode("0x60").replace("0033", "ffff")), /BYTECODE_INVALID/);
  });
  await test("R3 zero market tuples fall back to absolute defaults", () => {
    const ranges = r4.deriveEffectiveRange(r4.readAuthority().r3);
    assert.deepEqual(ranges.EModeLTV[47].effectiveConfig, ["50", "50", false, false]);
    assert.match(ranges.EModeLTV[47].interpretation, /not a relative/);
  });
  await test("slot decoder extracts and normalizes implementation", () => {
    assert.equal(r4.decodeSlot(slot), r4.A.hubImplementation);
    assert.throws(() => r4.decodeSlot("0x12"), /SLOT_INVALID/);
    assert.throws(() => r4.decodeSlot(`0x01${slot.slice(4)}`), /SLOT_INVALID/);
  });
  await test("agent immutable wiring decodes exactly", () => {
    for (const view of r4.AGENT_VIEWS) assert.equal(r4.decodeAgentView(view, viewResults.get(view.data)), view.expected);
    assert.throws(() => r4.decodeAgentView(r4.AGENT_VIEWS[0], `${viewResults.get(r4.AGENT_VIEWS[0].data)}00`), /AGENT_WIRING_INVALID/);
  });
  await test("two independent families establish and recheck historical binding", async () => {
    const authority = syntheticAuthority();
    const report = await r4.collect({ candidates: pair, rawCall: transport(), authority, pf, now: () => 1 });
    assert.equal(report.status, "CORROBORATED_HISTORICAL_OBSERVATIONS");
    assert.equal(report.selectedFamilyCount, 2);
    assert.equal(report.sourceBindings.hubExecutableMatch, true);
    assert.equal(report.sourceBindings.rangeExecutableMatch, true);
    assert.equal(report.gates.completeRuntimeBinding, false);
    assert.equal(report.gates.agentRuntimeBound, false);
    assert.equal(report.gates.completeAuthorityVerification, false);
    assert.equal(report.gates.effectiveRangeSemanticsBound, false);
    assert.equal(report.callsUsed, 52);
    assert.equal(r4.validateReport(report, authority), true);
  });
  await test("one family cannot establish consensus", async () => {
    await assert.rejects(r4.collect({ candidates: [pair[0], { ...pair[1], operatorFamily: pair[0].operatorFamily }],
      rawCall: transport(), authority: syntheticAuthority(), pf }), /HISTORICAL_CONSENSUS_UNAVAILABLE/);
  });
  await test("historical block mismatch is rejected", async () => {
    const rawCall = transport({ eth_getBlockByNumber: (params) => params[0] === "finalized" ? finalized : { ...header, hash: `0x${"1".repeat(64)}` } });
    await assert.rejects(r4.collect({ candidates: pair,
      rawCall, authority: syntheticAuthority(), pf }), /HISTORICAL_CONSENSUS_UNAVAILABLE/);
  });
  await test("wrong Hub implementation is rejected", async () => {
    const rawCall = transport({ eth_getStorageAt: () => `0x${"0".repeat(64)}` });
    await assert.rejects(r4.collect({ candidates: pair,
      rawCall, authority: syntheticAuthority(), pf }), /HISTORICAL_CONSENSUS_UNAVAILABLE/);
  });
  await test("request allowlist accepts only fixed historical reads", () => {
    assert.doesNotThrow(() => r4.allowRequest("eth_getStorageAt", [r4.A.hub, r4.IMPLEMENTATION_SLOT, r4.BLOCK]));
    assert.throws(() => r4.allowRequest("eth_sendRawTransaction", ["0x"]), /REQUEST_FORBIDDEN/);
    assert.throws(() => r4.allowRequest("eth_getCode", [r4.A.agent, "latest"]), /REQUEST_FORBIDDEN/);
    assert.throws(() => r4.allowRequest("eth_call", [{ to: r4.A.agent, data: r4.AGENT_VIEWS[0].data, value: "0x1" }, r4.BLOCK]), /REQUEST_FORBIDDEN/);
  });
  await test("late-qualified families fit qualification and terminal budgets", async () => {
    const base = transport();
    const rawCall = (handle, method, params) => handle < 5 && method === "eth_getCode" && params[0] === r4.A.hubImplementation
      ? bytecode(`0x60${(16 + handle).toString(16)}`) : base(handle, method, params);
    const authority = syntheticAuthority();
    const report = await r4.collect({ candidates, rawCall, authority, pf });
    assert.equal(report.selectedFamilyCount, 3);
    assert.equal(report.callsUsed, 143);
    assert.equal(r4.validateReport(report, authority), true);
  });
  await test("terminal historical changes cannot publish success", async () => {
    let slots = 0;
    const rawCall = transport({ eth_getStorageAt: () => ++slots > 2 ? `0x${"0".repeat(64)}` : slot });
    await assert.rejects(r4.collect({ candidates: pair, rawCall, authority: syntheticAuthority(), pf }), /HUB_IMPLEMENTATION_MISMATCH/);
  });
  await test("byte and wall caps are fatal across candidate changes", async () => {
    for (const code of ["BYTE_CAP", "WALL_CAP"]) {
      let requests = 0;
      await assert.rejects(r4.collect({ candidates, rawCall: () => { requests += 1; throw new r4.R4Error(code); }, authority: syntheticAuthority(), pf }), new RegExp(code));
      assert.equal(requests, 1);
    }
  });
  await test("report validation rejects forged bindings, gates and evidence", async () => {
    const authority = syntheticAuthority(), report = await r4.collect({ candidates: pair, rawCall: transport(), authority, pf });
    for (const mutate of [
      (r) => { r.gates.completeAuthorityVerification = true; },
      (r) => { r.gates.effectiveRangeSemanticsBound = true; },
      (r) => { r.sourceBindings.hubExecutableMatch = false; },
      (r) => { r.observation.code.range.keccak256 = `0x${"ff".repeat(32)}`; },
      (r) => { r.effectiveRange.EModeLTV[47].effectiveConfig[2] = true; }
    ]) {
      const changed = structuredClone(report); mutate(changed);
      assert.throws(() => r4.validateReport(changed, authority), /OUTPUT_INVALID/);
    }
  });
  await test("metadata-only differences are not exact-runtime matches", async () => {
    const authority = syntheticAuthority(), base = transport();
    const rawCall = (handle, method, params) => method === "eth_getCode" && params[0] === r4.A.hubImplementation
      ? codes[r4.A.hubImplementation].replace("12".repeat(32), "34".repeat(32)) : base(handle, method, params);
    const report = await r4.collect({ candidates: pair, rawCall, authority, pf });
    assert.equal(report.sourceBindings.hubExecutableMatch, true);
    assert.equal(report.sourceBindings.hubExactMetadataMatch, false);
    assert.equal(r4.validateReport(report, authority), true);
  });
  await test("transport accepts strict JSON-RPC envelopes", async () => {
    const handle = { url: new URL("https://example.invalid") };
    const rpc = r4.createTransport([{ handle }], { request: fakeRequest((res, request) => {
      res.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x1" })));
      res.emit("end");
    }) });
    assert.equal(await rpc.call(handle, "eth_chainId", []), "0x1");
    assert.equal(rpc.stats.calls, 1);
  });
  await test("transport rejects missing results without exposing raw errors", async () => {
    const handle = { url: new URL("https://example.invalid") };
    const rpc = r4.createTransport([{ handle }], { request: fakeRequest((res, request) => {
      res.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id })));
      res.emit("end");
    }) });
    await assert.rejects(rpc.call(handle, "eth_chainId", []), /RPC_UNAVAILABLE/);
  });
  await test("transport latches byte cap and ignores late chunks", async () => {
    const handle = { url: new URL("https://example.invalid") };
    const rpc = r4.createTransport([{ handle }], { request: fakeRequest((res) => {
      res.emit("data", Buffer.alloc(r4.LIMITS.responseBytes + 1));
      res.emit("data", Buffer.alloc(10)); res.emit("end");
    }) });
    await assert.rejects(rpc.call(handle, "eth_chainId", []), /BYTE_CAP/);
    await assert.rejects(rpc.call(handle, "eth_chainId", []), /BYTE_CAP/);
    assert.deepEqual(rpc.stats, { calls: 1, responseBytes: r4.LIMITS.responseBytes + 1 });
  });
  await test("transport enforces wall cap at response completion", async () => {
    const handle = { url: new URL("https://example.invalid") }; let clock = 0;
    const rpc = r4.createTransport([{ handle }], { monotonic: () => clock, request: fakeRequest((res, request) => {
      res.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x1" })));
      clock = r4.LIMITS.wallMs; res.emit("end");
    }) });
    await assert.rejects(rpc.call(handle, "eth_chainId", []), /WALL_CAP/);
    await assert.rejects(rpc.call(handle, "eth_chainId", []), /WALL_CAP/);
    assert.equal(rpc.stats.calls, 1);
  });
  await test("runOnce publishes success in isolation and refuses a second attempt", async () => temporaryRun(async (root) => {
    const authority = syntheticAuthority();
    const options = { root, candidates: pair, rawCall: transport(), authority };
    const result = await r4.runOnce(options);
    assert.equal(result.report.status, "CORROBORATED_HISTORICAL_OBSERVATIONS");
    assert.equal(result.report.executionMode, "injected");
    assert.equal(result.report.inventoryReads, 0);
    assert.equal(result.sha256, r4.sha256(r4.stable(result.report)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, r4.OUTPUT))), result);
    const attempt = JSON.parse(fs.readFileSync(path.join(root, r4.ATTEMPT)));
    assert.equal(attempt.executionMode, "injected");
    assert.deepEqual(attempt.sourceHashes, result.report.sourceHashes);
    await assert.rejects(r4.runOnce(options), /ATTEMPT_CONSUMED/);
  }));
  await test("runOnce records sanitized failure and consumes only its test marker", async () => temporaryRun(async (root) => {
    const options = { root, candidates: pair, rawCall: () => { throw Object.assign(new Error("synthetic-private-value"), { code: "synthetic-private-value" }); } };
    const result = await r4.runOnce(options);
    assert.equal(result.report.status, "INCOMPLETE");
    assert.equal(result.report.code, "HISTORICAL_CONSENSUS_UNAVAILABLE");
    assert.equal(result.report.callsUsed, 2);
    assert.equal(r4.stable(result).includes("synthetic-private-value"), false);
    assert.equal(r4.safeCode({ code: "synthetic-private-value" }), "UNEXPECTED");
    await assert.rejects(r4.runOnce(options), /ATTEMPT_CONSUMED/);
  }));
  await test("invalid injection cannot fall through to real inventory or production output", async () => {
    await assert.rejects(r4.runOnce({ root: r4.ROOT, candidates: pair, rawCall: transport() }), /INPUT_INVALID/);
    await assert.rejects(r4.runOnce({ candidates: pair }), /INPUT_INVALID/);
    await assert.rejects(r4.runOnce(), /INVOCATION_INVALID/);
  });
  await test("production artifacts remain unchanged during offline tests", () => {
    const after = [r4.OUTPUT, r4.ATTEMPT].map((file) => fs.existsSync(path.join(r4.ROOT, file)) ? r4.sha256(fs.readFileSync(path.join(r4.ROOT, file))) : null);
    assert.deepEqual(after, productionBefore);
  });
  process.stdout.write(`${tests} tests passed\n`);
})().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
