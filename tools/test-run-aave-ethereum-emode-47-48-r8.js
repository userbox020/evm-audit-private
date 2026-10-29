#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const r8 = require("./run-aave-ethereum-emode-47-48-r8.js");
const pf = require("./lib/common-finalized-rpc-preflight.js");
const authority = r8.readAuthority();
const candidates = pf.REVIEWED_OPERATOR_FAMILY_IDS.map((operatorFamily, handle) => ({ handle, operatorFamily }));
const pair = candidates.slice(0, 2), pin = r8.r4.PIN;
const header = { number: `0x${pin.number.toString(16)}`, hash: pin.hash, parentHash: pin.parentHash,
  stateRoot: pin.stateRoot, timestamp: `0x${BigInt(pin.timestamp).toString(16)}` };
const finalized = { ...header, number: `0x${(pin.number + 100).toString(16)}` };
const metadata = `a2646970667358221220${"12".repeat(32)}64736f6c634300081b0033`;
const differentCode = `0x6000fe${metadata}`;

function mock(overrides = {}) {
  return async (handle, method, params) => {
    r8.allowRequest(method, params);
    if (overrides[method]) return overrides[method](params, handle);
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return params[0] === "finalized" ? finalized : header;
    if (method === "eth_getCode") return authority.retainedCode;
    assert.fail("UNEXPECTED_METHOD");
  };
}
const collect = (rawCall, selected = pair) => r8.collect({ candidates: selected, rawCall, authority, pf });
const productionPaths = [r8.OUTPUT, r8.ATTEMPT, ...Object.keys(authority.sourceHashes)];
const before = productionPaths.map((file) => fs.existsSync(path.join(r8.ROOT, file)) ? r8.r4.sha256(fs.readFileSync(path.join(r8.ROOT, file))) : null);
let tests = 0;
async function test(name, run) { await run(); tests += 1; console.log(`ok ${tests} - ${name}`); }
async function temporary(run) {
  const root = fs.mkdtempSync("C:/Users/MiPC/AppData/Local/Temp/opencode/emode-r8-test-");
  fs.mkdirSync(path.join(root, "reports/raw/fast"), { recursive: true });
  try { await run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

(async () => {
  await test("retained R5-R7 authority is pinned and internally consistent", () => {
    assert.equal(Object.keys(authority.sourceHashes).length, 10);
    assert.equal(authority.retained.keccak256, "0x654f68fa72fa38eafbc5e15039fbad0aa373c95378c9b0322bca4fd8041ac538");
    assert.equal(authority.retained.bytes, 13480);
  });
  await test("two families corroborate exact historical code without promoting authority", async () => {
    const report = await collect(mock());
    assert.equal(report.status, "CORROBORATED_HISTORICAL_HUB_CODE");
    assert.equal(report.callsUsed, 18); assert.equal(report.selectedFamilyCount, 2);
    assert.equal(report.comparisons.exactRetainedExplorerRuntime, true);
    assert.equal(report.comparisons.normalizedExecutableSourceMatch, true);
    assert.equal(report.gates.completeAuthorityVerification, false);
    assert.equal(report.gates.completeRuntimeBinding, false);
    assert.equal(r8.validateReport(report, authority), true);
  });
  await test("corroborated different code remains a mismatch, not a source binding", async () => {
    const report = await collect(mock({ eth_getCode: () => differentCode }));
    assert.equal(report.status, "CORROBORATED_HISTORICAL_HUB_CODE");
    assert.equal(report.comparisons.exactRetainedExplorerRuntime, false);
    assert.equal(report.gates.hubHistoricalExecutableSourceBound, false);
    assert.equal(r8.validateReport(report, authority), true);
  });
  await test("metadata-only difference retains normalized executable source binding", async () => {
    const changedMetadata = authority.retainedCode.slice(0, -(53 * 2)) + `a2646970667358221220${"34".repeat(32)}64736f6c634300081b0033`;
    const report = await collect(mock({ eth_getCode: () => changedMetadata }));
    assert.equal(report.comparisons.exactRetainedExplorerRuntime, false);
    assert.equal(report.comparisons.normalizedExecutableSourceMatch, true);
    assert.equal(report.gates.hubHistoricalExecutableSourceBound, true);
    assert.equal(r8.validateReport(report, authority), true);
  });
  await test("different family observations cannot form consensus", async () => {
    const report = await collect(mock({ eth_getCode: (_params, handle) => handle ? differentCode : authority.retainedCode }));
    assert.equal(report.status, "INCOMPLETE"); assert.equal(report.code, "HISTORICAL_CODE_CONSENSUS_UNAVAILABLE");
    assert.equal(report.observation, null); assert.equal(r8.validateReport(report, authority), true);
  });
  await test("one family cannot establish historical code", async () => {
    await assert.rejects(collect(mock(), [pair[0]]), /INPUT_INVALID/);
  });
  await test("unknown family is rejected before requests", async () => {
    let calls = 0;
    await assert.rejects(collect(() => { calls += 1; }, [pair[0], { ...pair[1], operatorFamily: "unknown" }]), /INPUT_INVALID/);
    assert.equal(calls, 0);
  });
  await test("wrong chain remains a staged non-consensus blocker", async () => {
    const report = await collect(mock({ eth_chainId: () => "0x2" }));
    assert.deepEqual(report.failureCounts, { "CHAIN_ID:CHAIN_MISMATCH": 2 });
    assert.equal(r8.validateReport(report, authority), true);
  });
  await test("fixed historical header mismatch is explicit", async () => {
    const report = await collect(mock({ eth_getBlockByNumber: (params) => params[0] === "finalized" ? finalized : { ...header, hash: `0x${"00".repeat(32)}` } }));
    assert.deepEqual(report.failureCounts, { "HISTORICAL_HEADER:HISTORICAL_HEADER_MISMATCH": 2 });
    assert.equal(r8.validateReport(report, authority), true);
  });
  await test("empty and malformed implementation code are rejected", async () => {
    for (const code of ["0x", "0x0", "not-hex"]) {
      const report = await collect(mock({ eth_getCode: () => code }));
      assert.equal(report.failureCounts["IMPLEMENTATION_CODE:CODE_INVALID"], 2);
      assert.equal(r8.validateReport(report, authority), true);
    }
  });
  await test("terminal code change retracts corroboration", async () => {
    let codeReads = 0;
    const report = await collect(mock({ eth_getCode: () => ++codeReads > 2 ? differentCode : authority.retainedCode }));
    assert.equal(report.status, "INCOMPLETE"); assert.equal(report.code, "TERMINAL_RECHECK_FAILED");
    assert.equal(report.terminal.length, 1); assert.equal(r8.validateReport(report, authority), true);
  });
  await test("fatal budget errors stop with sanitized diagnostics", async () => {
    for (const code of ["BYTE_CAP", "WALL_CAP", "NETWORK_CALL_CAP"]) {
      const report = await collect(() => { throw new r8.R8Error(code); });
      assert.equal(report.status, "INCOMPLETE"); assert.equal(report.code, code); assert.equal(r8.validateReport(report, authority), true);
    }
  });
  await test("only the bounded read methods and target are permitted", () => {
    for (const [method, params] of [["eth_getStorageAt", []], ["eth_call", []], ["eth_getCode", [r8.r4.A.hub, r8.r4.BLOCK]],
      ["eth_getCode", [r8.r4.A.hubImplementation, "latest"]]]) assert.throws(() => r8.allowRequest(method, params), /REQUEST_FORBIDDEN/);
  });
  await test("validator rejects promoted gates and tampered comparisons", async () => {
    const report = await collect(mock());
    for (const mutate of [(v) => { v.gates.completeAuthorityVerification = true; }, (v) => { v.comparisons.exactRetainedExplorerRuntime = false; },
      (v) => { v.observation.bytes += 1; }, (v) => { v.diagnostics[0].calls += 1; }, (v) => { v.extra = true; }]) {
      const changed = structuredClone(report); mutate(changed); assert.throws(() => r8.validateReport(changed, authority), /OUTPUT_INVALID/);
    }
  });
  await test("isolated injected publication is append-only and inventory-free", async () => temporary(async (root) => {
    const options = { root, candidates: pair, rawCall: mock(), now: () => Date.parse("2026-09-09T00:00:00Z") };
    const result = await r8.runOnce(options);
    assert.equal(result.report.executionMode, "injected"); assert.equal(result.report.inventoryReads, 0);
    assert.equal(result.report.responseBytes, null); assert.equal(result.sha256, r8.r4.sha256(r8.r4.stable(result.report)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, r8.OUTPUT))), result);
    await assert.rejects(r8.runOnce(options), /ATTEMPT_CONSUMED/);
  }));
  await test("unexpected errors are sanitized in durable injected output", async () => temporary(async (root) => {
    const result = await r8.runOnce({ root, candidates: pair, rawCall: () => { throw new Error("https://secret.invalid"); } });
    assert.equal(result.report.failureCounts["CHAIN_ID:UNEXPECTED"], 2);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }));
  await test("production artifacts and retained authority remain unchanged", () => {
    const after = productionPaths.map((file) => fs.existsSync(path.join(r8.ROOT, file)) ? r8.r4.sha256(fs.readFileSync(path.join(r8.ROOT, file))) : null);
    assert.deepEqual(after, before);
  });
  console.log(`${tests} tests passed`);
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
