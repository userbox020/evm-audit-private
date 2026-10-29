#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const r5 = require("./run-aave-ethereum-emode-47-48-r5.js");
const { r4 } = r5;
const pf = require("./lib/common-finalized-rpc-preflight.js");
const { keccak256 } = require("ethers");
const candidates = pf.REVIEWED_OPERATOR_FAMILY_IDS.map((operatorFamily, handle) => ({ handle, operatorFamily })), pair = candidates.slice(0, 2);
const header = { number: `0x${r4.PIN.number.toString(16)}`, hash: r4.PIN.hash, parentHash: r4.PIN.parentHash,
  stateRoot: r4.PIN.stateRoot, timestamp: `0x${BigInt(r4.PIN.timestamp).toString(16)}` };
const finalized = { ...header, number: `0x${(r4.PIN.number + 100).toString(16)}` };
const different = "0x1111111111111111111111111111111111111111";
const slot = (address) => `0x${"0".repeat(24)}${address.slice(2)}`;
const metadata = `a2646970667358221220${"12".repeat(32)}64736f6c634300081b0033`;
const codes = Object.fromEntries([r4.A.hub, r4.A.hubImplementation, r4.A.agent, r4.A.range].map((address, i) => [address, `0x600${i}fe${metadata}`]));
const viewResults = Object.fromEntries(r4.AGENT_VIEWS.map((view) => [view.data, view.iface.encodeFunctionResult(view.fn, [view.expected])]));
const actualInputs = r5.readInputs();
function authority() {
  const value = structuredClone(actualInputs.authority);
  for (const key of ["hub", "agent", "range"]) value.r3.report.observations.current.code[key] = { bytes: (codes[r4.A[key]].length - 2) / 2, keccak256: keccak256(codes[r4.A[key]]) };
  return value;
}
function mock(overrides = {}) {
  return async (handle, method, params) => {
    r4.allowRequest(method, params);
    if (overrides[method]) return overrides[method](params, handle);
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return params[0] === "finalized" ? finalized : header;
    if (method === "eth_getStorageAt") return slot(r4.A.hubImplementation);
    if (method === "eth_getCode") return codes[params[0]];
    if (method === "eth_call") return viewResults[params[0].data];
    assert.fail("UNEXPECTED_METHOD");
  };
}
const collect = (rawCall, selected = pair) => r5.collect({ candidates: selected, rawCall, authority: authority(), pf });
const productionPaths = [r5.OUTPUT, r5.ATTEMPT, ...Object.keys(actualInputs.sourceHashes)];
const before = productionPaths.map((file) => fs.existsSync(path.join(r5.ROOT, file)) ? r4.sha256(fs.readFileSync(path.join(r5.ROOT, file))) : null);
let tests = 0;
async function test(name, run) { await run(); tests += 1; console.log(`ok ${tests} - ${name}`); }
async function temporary(run) {
  const root = fs.mkdtempSync("C:/Users/MiPC/AppData/Local/Temp/opencode/emode-r5-test-");
  fs.mkdirSync(path.join(root, "reports/raw/fast"), { recursive: true });
  try { await run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
(async () => {
  await test("previous packages and compiler inputs remain pinned", () => assert.ok(Object.keys(actualInputs.sourceHashes).length >= 28));
  await test("expected implementation is corroborated without promoting full assurance", async () => {
    const report = await collect(mock());
    assert.equal(report.status, "CORROBORATED_IMPLEMENTATION_SLOT");
    assert.equal(report.implementation.address, r4.A.hubImplementation);
    assert.equal(report.callsUsed, 34);
    assert.equal(report.gates.completeRuntimeBinding, false);
    assert.equal(report.gates.completeAuthorityVerification, false);
    assert.equal(r5.validateReport(report), true);
  });
  await test("different valid implementation is retained, rechecked and never followed", async () => {
    const base = mock({ eth_getStorageAt: () => slot(different) }); let codeCalls = 0;
    const report = await collect((handle, method, params) => { if (method === "eth_getCode" || method === "eth_call") codeCalls += 1; return base(handle, method, params); });
    assert.equal(report.status, "CORROBORATED_IMPLEMENTATION_SLOT");
    assert.deepEqual(report.implementation, { address: different, matchesCandidate: false, familyCount: 2, ordinals: [0, 1] });
    assert.equal(report.failureCounts["IMPLEMENTATION_SLOT:HUB_IMPLEMENTATION_MISMATCH"], 2);
    assert.equal(report.callsUsed, 16); assert.equal(codeCalls, 0);
    assert.equal(r5.validateReport(report), true);
  });
  await test("wrong chain yields explicit stage diagnostics", async () => {
    const report = await collect(mock({ eth_chainId: () => "0x2" }));
    assert.equal(report.status, "DIAGNOSTIC_ONLY");
    assert.deepEqual(report.failureCounts, { "CHAIN_ID:CHAIN_MISMATCH": 2 });
    assert.equal(report.implementation, null); assert.equal(r5.validateReport(report), true);
  });
  await test("historical header mismatch is distinguished from RPC failure", async () => {
    const report = await collect(mock({ eth_getBlockByNumber: (params) => params[0] === "finalized" ? finalized : { ...header, hash: `0x${"00".repeat(32)}` } }));
    assert.equal(report.failureCounts["HISTORICAL_HEADER:HISTORICAL_HEADER_MISMATCH"], 2);
    assert.equal(r5.validateReport(report), true);
  });
  await test("unavailable historical slot reads retain their failure stage", async () => {
    const report = await collect(mock({ eth_getStorageAt: () => { throw new r4.R4Error("RPC_UNAVAILABLE"); } }));
    assert.equal(report.failureCounts["IMPLEMENTATION_SLOT:RPC_UNAVAILABLE"], 2);
    assert.equal(report.implementation, null); assert.equal(r5.validateReport(report), true);
  });
  await test("malformed slot responses cannot supply implementation evidence", async () => {
    const report = await collect(mock({ eth_getStorageAt: () => "0x12" }));
    assert.equal(report.failureCounts["IMPLEMENTATION_SLOT:SLOT_INVALID"], 2);
    assert.equal(report.implementation, null); assert.equal(r5.validateReport(report), true);
  });
  await test("runtime metadata rejection is localized without losing slot observations", async () => {
    const report = await collect(mock({ eth_getCode: () => "0x60000000" }));
    assert.equal(report.failureCounts["HUB_METADATA:BYTECODE_INVALID"], 2);
    assert.equal(report.implementation.address, r4.A.hubImplementation);
    assert.equal(report.gates.completeRuntimeBinding, false); assert.equal(r5.validateReport(report), true);
  });
  await test("agent getter rejection is distinguished by getter", async () => {
    const report = await collect(mock({ eth_call: () => "0x" }));
    assert.equal(report.failureCounts["AGENT_HUB_GETTER:AGENT_WIRING_INVALID"], 2);
    assert.equal(r5.validateReport(report), true);
  });
  await test("single family cannot corroborate the historical slot", async () => {
    const report = await collect(mock(), [pair[0], { ...pair[1], operatorFamily: pair[0].operatorFamily }]);
    assert.equal(report.status, "DIAGNOSTIC_ONLY"); assert.equal(report.implementation, null);
    assert.equal(r5.validateReport(report), true);
  });
  await test("unknown family classifications are rejected before any request", async () => {
    for (const operatorFamily of [null, undefined, "unreviewed"]) {
      let calls = 0;
      await assert.rejects(collect(() => { calls += 1; }, [pair[0], { ...pair[1], operatorFamily }]), /INPUT_INVALID/);
      assert.equal(calls, 0);
    }
  });
  await test("disagreeing slot observations remain uncorroborated", async () => {
    const report = await collect(mock({ eth_getStorageAt: (_params, handle) => slot(handle ? different : r4.A.hubImplementation) }));
    assert.equal(report.status, "DIAGNOSTIC_ONLY"); assert.equal(report.terminal.length, 0);
    assert.equal(r5.validateReport(report), true);
  });
  await test("terminal slot disagreement retracts corroboration and retains the changed value", async () => {
    let reads = 0;
    const report = await collect(mock({ eth_getStorageAt: () => slot(++reads > 2 ? different : r4.A.hubImplementation) }));
    assert.equal(report.status, "INCOMPLETE"); assert.equal(report.implementation, null);
    assert.equal(report.terminal[0].implementation, different);
    assert.deepEqual(report.abort, { stage: "TERMINAL_SLOT", code: "TERMINAL_RECHECK_FAILED" });
    assert.equal(report.terminal.length, 1); assert.equal(r5.validateReport(report), true);
  });
  await test("terminal header disagreement cannot retain a slot certificate", async () => {
    let finalizedReads = 0;
    const report = await collect(mock({ eth_getBlockByNumber: (params) => {
      if (params[0] === "finalized") { finalizedReads += 1; return finalized; }
      return finalizedReads > 2 ? { ...header, hash: `0x${"ff".repeat(32)}` } : header;
    } }));
    assert.deepEqual(report.abort, { stage: "TERMINAL_HEADER", code: "HISTORICAL_HEADER_MISMATCH" });
    assert.equal(report.implementation, null); assert.equal(r5.validateReport(report), true);
  });
  await test("fatal budgets stop without discarding the diagnostic transcript", async () => {
    for (const code of ["BYTE_CAP", "WALL_CAP", "NETWORK_CALL_CAP"]) {
      const report = await collect(() => { throw new r4.R4Error(code); });
      assert.equal(report.status, "INCOMPLETE"); assert.equal(report.diagnostics.length, 1);
      assert.equal(report.callsUsed, 1); assert.equal(report.abort.code, code); assert.equal(r5.validateReport(report), true);
    }
  });
  await test("late matching families remain within the bounded read budget", async () => {
    const report = await collect(mock({ eth_getStorageAt: (_params, handle) => slot(handle < 6 ? `0x${(handle + 20).toString(16).padStart(40, "0")}` : r4.A.hubImplementation) }), candidates);
    assert.equal(report.implementation.familyCount, 2);
    assert.deepEqual(report.implementation.ordinals, [6, 7]);
    assert.ok(report.callsUsed <= r5.LIMITS.calls); assert.equal(r5.validateReport(report), true);
  });
  await test("raw exception details cannot become persisted diagnostics", async () => {
    const report = await collect(() => { throw Object.assign(new Error("synthetic-private-value"), { code: "https://example.invalid/private" }); });
    assert.deepEqual(report.failureCounts, { "CHAIN_ID:UNEXPECTED": 2 });
    assert.equal(r4.stable(report).includes("private"), false); assert.equal(r5.validateReport(report), true);
  });
  await test("validator rejects tampered stages, counts, corroboration and promoted gates", async () => {
    const report = await collect(mock());
    for (const mutate of [
      (value) => { value.diagnostics[0].stage = "untrusted"; },
      (value) => { value.diagnostics[0].stage = "CHAIN_ID"; value.diagnostics[0].code = "CHAIN_MISMATCH"; value.failureCounts = r5.failureCounts(value); },
      (value) => { value.diagnostics[0].calls += 1; },
      (value) => { value.terminal[0].implementation = different; },
      (value) => { value.implementation.ordinals = [0, 0]; },
      (value) => { value.gates.completeAuthorityVerification = true; },
      (value) => { value.extra = "synthetic-private-value"; }
    ]) { const changed = structuredClone(report); mutate(changed); assert.throws(() => r5.validateReport(changed), /OUTPUT_INVALID/); }
  });
  await test("isolated publication preserves diagnostics and refuses another attempt", async () => temporary(async (root) => {
    const options = { root, candidates: pair, rawCall: mock({ eth_getStorageAt: () => slot(different) }), authority: authority() };
    const result = await r5.runOnce(options);
    assert.equal(result.report.executionMode, "injected"); assert.equal(result.report.inventoryReads, 0);
    assert.equal(result.sha256, r4.sha256(r4.stable(result.report)));
    assert.equal(result.report.implementation.address, different);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, r5.OUTPUT))), result);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, r5.ATTEMPT))).sourceHashes, result.report.sourceHashes);
    await assert.rejects(r5.runOnce(options), /ATTEMPT_CONSUMED/);
  }));
  await test("incomplete transcripts are durable without real inventory fallback", async () => temporary(async (root) => {
    const options = { root, candidates: pair, rawCall: mock({ eth_getStorageAt: () => { throw new r4.R4Error("RPC_UNAVAILABLE"); } }), authority: authority() };
    const result = await r5.runOnce(options);
    assert.equal(result.report.failureCounts["IMPLEMENTATION_SLOT:RPC_UNAVAILABLE"], 2);
    assert.equal(result.report.inventoryReadAttempts, 0);
    await assert.rejects(r5.runOnce(options), /ATTEMPT_CONSUMED/);
  }));
  await test("fatal capture failure publishes its stage and transcript", async () => temporary(async (root) => {
    const result = await r5.runOnce({ root, candidates: pair, rawCall: () => { throw new r4.R4Error("BYTE_CAP"); } });
    assert.equal(result.report.status, "INCOMPLETE");
    assert.deepEqual(result.report.abort, { stage: "CHAIN_ID", code: "BYTE_CAP" });
    assert.equal(result.report.diagnostics.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, r5.OUTPUT))), result);
  }));
  await test("setup failures publish a zero-read record without real inventory", async () => temporary(async (root) => {
    const result = await r5.runOnce({ root, candidates: [], rawCall: mock() });
    assert.equal(result.report.status, "INCOMPLETE");
    assert.deepEqual(result.report.abort, { stage: "COLLECT", code: "INPUT_INVALID" });
    assert.equal(result.report.callsUsed, 0); assert.equal(result.report.inventoryReads, 0);
    assert.deepEqual(result.report.diagnostics, []);
  }));
  await test("invalid injection is rejected before production paths can be touched", async () => {
    await assert.rejects(r5.runOnce({ root: r5.ROOT, rawCall: mock(), candidates: pair }), /INPUT_INVALID/);
    await assert.rejects(r5.runOnce({ candidates: pair }), /INPUT_INVALID/);
    await assert.rejects(r5.runOnce(), /INVOCATION_INVALID/);
  });
  await test("R3, R4 and production R5 artifacts remain unchanged by offline tests", () => {
    const after = productionPaths.map((file) => fs.existsSync(path.join(r5.ROOT, file)) ? r4.sha256(fs.readFileSync(path.join(r5.ROOT, file))) : null);
    assert.deepEqual(after, before);
  });
  console.log(`${tests} tests passed`);
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
