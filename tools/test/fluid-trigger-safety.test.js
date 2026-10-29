"use strict";
// Offline safety tests for the Fluid T2/T4 trigger chain.
// No side effects on import: the trigger module does not run main(), and the refresh
// module is guarded by require.main. No keys, providers, RPC, or live artifacts.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const trigger = require("../execute-fluid-t2t4-trigger.js");
const refresh = require("../reference-fluid-surface-refresh.js");

const DEBT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC (raw unit only)
const OTHER = "0x00000000000000000000000000000000000000ff";
const ARB = "0x9795000000000000000000000000000000000001";
const BASE = "0x59fa000000000000000000000000000000000001";
const ETH_UNSIZED = "0x5668000000000000000000000000000000000001";
const ETH_ELIGIBLE = "0x989a000000000000000000000000000000000001";

const DEPTH_SIZED_EXEC = { outQuoted: "5000000", netAtQuotedSize: "4000000", executableAtQuotedSize: true };
const DEPTH_SIZED_NOT_EXEC = { outQuoted: "5000000", netAtQuotedSize: "4000000", executableAtQuotedSize: false };
const DEPTH_SIZED_NOT_EXEC_HIGH = { outQuoted: "99000000", netAtQuotedSize: "99000000", executableAtQuotedSize: false };
const DEPTH_UNKNOWN_EXEC = { outQuoted: "5000000", netAtQuotedSize: "4000000" };
const DEPTH_UNSIZED = { outQuoted: "0", netAtQuotedSize: null, executableAtQuotedSize: false };

function mkRow(vault, chainId, opts) {
  const o = opts || {};
  const debt = o.debt || DEBT;
  return {
    vault,
    chainId,
    routePositive: true,
    debtToken: debt,
    colToken0: o.col0 !== undefined ? o.col0 : debt,
    colToken1: o.col1 !== undefined ? o.col1 : OTHER,
    netUsdc: o.netUsdc || "1000000",
    gasBoundUsdc: "1",
    exitDepth: o.exitDepth,
  };
}

function fakeJson(value, exists = true, ok = true) {
  return { readJson: () => ({ exists, ok, value }) };
}

test("mixed fixture: other-chain / non-executable / unsized rows are ineligible BEFORE sort+slice; ETH candidate eligible", () => {
  const rows = [
    mkRow(ARB, 42161, { exitDepth: DEPTH_SIZED_NOT_EXEC, netUsdc: "9000000" }),
    mkRow(BASE, 8453, { exitDepth: DEPTH_SIZED_NOT_EXEC, netUsdc: "8000000" }),
    mkRow(ETH_UNSIZED, 1, { exitDepth: DEPTH_UNSIZED, netUsdc: "7000000" }),
    // high-net but non-executable estimate on Ethereum: must NOT consume a probe slot
    mkRow("0xaaaa000000000000000000000000000000000001", 1, { exitDepth: DEPTH_SIZED_NOT_EXEC_HIGH }),
    mkRow(ETH_ELIGIBLE, 1, { exitDepth: DEPTH_SIZED_EXEC, netUsdc: "1000000" }),
  ];
  const { eligible, rejected, eligibleTotal } = trigger.selectProbeRows(rows, new Map());
  assert.equal(eligibleTotal, 1);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].row.vault, ETH_ELIGIBLE);

  const byVault = new Map(rejected.map(r => [r.vault, r]));
  assert.equal(byVault.get(ARB.toLowerCase()).skip, "chainId-not-ethereum(42161)");
  assert.equal(byVault.get(BASE.toLowerCase()).skip, "chainId-not-ethereum(8453)");
  assert.equal(byVault.get(ETH_UNSIZED.toLowerCase()).skip, "exit-depth-unsized");
  assert.equal(byVault.get("0xaaaa000000000000000000000000000000000001").skip, "exit-depth-not-executable");
  // every rejection carries the full vault + chainId (no 12-char slicing)
  for (const r of rejected) {
    assert.equal(typeof r.vault, "string");
    assert.equal(r.vault.length, 42);
    assert.ok(r.chainId === null || typeof r.chainId === "number");
  }
});

test("false and unknown executable flags are rejected; missing chainId fails closed", () => {
  const falseRow = mkRow("0xbbbb000000000000000000000000000000000001", 1, { exitDepth: DEPTH_SIZED_NOT_EXEC });
  const unknownRow = mkRow("0xcccc000000000000000000000000000000000001", 1, { exitDepth: DEPTH_UNKNOWN_EXEC });
  const missingChain = mkRow("0xdddd000000000000000000000000000000000001", undefined, { exitDepth: DEPTH_SIZED_EXEC });
  missingChain.chainId = undefined;

  const dFalse = trigger.pickExitDepth(falseRow, new Map());
  const dUnknown = trigger.pickExitDepth(unknownRow, new Map());
  assert.equal(trigger.isEligibleRow(falseRow, dFalse).reason, "exit-depth-not-executable");
  assert.equal(trigger.isEligibleRow(unknownRow, dUnknown).reason, "exit-depth-not-executable");
  assert.equal(trigger.isEligibleRow(missingChain, trigger.pickExitDepth(missingChain, new Map())).reason, "chainId-missing");

  const { eligible } = trigger.selectProbeRows([falseRow, unknownRow, missingChain], new Map());
  assert.equal(eligible.length, 0);
});

test("debt token not delivered by the row's own exit pool is rejected", () => {
  const foreign = mkRow("0xeeee000000000000000000000000000000000001", 1, {
    exitDepth: DEPTH_SIZED_EXEC,
    col0: OTHER,
    col1: "0x00000000000000000000000000000000000000fe",
  });
  const d = trigger.pickExitDepth(foreign, new Map());
  assert.equal(trigger.isEligibleRow(foreign, d).reason, "debt-token-not-in-exit-pool");
});

test("the three-probe limit remains and ordering is net-descending", () => {
  const mk = (i) => mkRow("0x" + i.toString(16).padStart(2, "0").repeat(20), 1, {
    exitDepth: { outQuoted: "1000", netAtQuotedSize: String(i), executableAtQuotedSize: true },
  });
  const { eligible, eligibleTotal } = trigger.selectProbeRows([mk(1), mk(2), mk(3), mk(4)], new Map());
  assert.equal(trigger.MAX_ROW_PROBES, 3);
  assert.equal(eligibleTotal, 4);
  assert.equal(eligible.length, 3);
  assert.deepEqual(eligible.map(e => e.net.toString()), ["4", "3", "2"]);
});

test("gate c rejects mock-driven PASS, generic/unknown PASS, and unbound 'real' labels", () => {
  const mockModes = trigger.gateRehearsal(fakeJson({ summary: { modes: ["MOCK_DRIVEN"], pass: 2, failClosed: 0 } }));
  assert.equal(mockModes.ok, false);
  assert.match(mockModes.detail, /rehearsal-mock-driven-not-live-proof/);

  const mockRows = trigger.gateRehearsal(fakeJson({ summary: { pass: 2, failClosed: 0 }, rows: [{ provenance: "mock" }] }));
  assert.equal(mockRows.ok, false);
  assert.match(mockRows.detail, /rehearsal-mock-driven-not-live-proof/);

  // euler-shape pass2/failClosed0 (the current mock harness output) must not bypass
  const pass2 = trigger.gateRehearsal(fakeJson({ summary: { pass: 2, failClosed: 0 } }));
  assert.equal(pass2.ok, false);
  assert.match(pass2.detail, /rehearsal-real-candidate-proof-unavailable/);

  const genericPass = trigger.gateRehearsal(fakeJson({ state: "PASS" }));
  assert.equal(genericPass.ok, false);
  assert.match(genericPass.detail, /rehearsal-real-candidate-proof-unavailable/);

  const unknownState = trigger.gateRehearsal(fakeJson({ state: "UNKNOWN", summary: { pass: 2, failClosed: 0 } }));
  assert.equal(unknownState.ok, false);

  const unboundReal = trigger.gateRehearsal(fakeJson({ state: "PASS", proof: { real: true }, summary: { pass: 1, failClosed: 0, modes: ["REAL"] } }));
  assert.equal(unboundReal.ok, false);
  assert.match(unboundReal.detail, /rehearsal-real-candidate-proof-unavailable/);

  const missing = trigger.gateRehearsal(fakeJson(null, false, false));
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /rehearsal-result-missing/);
});

test("CLI --execute with mocked filesystem blocks key + provider before access (gate c)", async () => {
  let keyRead = false;
  let providerCalled = false;
  let payload = null;
  const now = Date.now();
  const bundle = {
    approved: true,
    expiresAt: new Date(now + 3_600_000).toISOString(),
    account: { address: "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a" },
    triggerGated: { requiredBeforeSignedTx: [] },
    batchId: "offline-test-batch",
    caps: {},
  };
  const economics = { generatedAt: new Date(now).toISOString(), rows: [mkRow(ETH_ELIGIBLE, 1, { exitDepth: DEPTH_SIZED_EXEC })] };
  const rehearsal = { summary: { modes: ["MOCK_DRIVEN"], pass: 2, failClosed: 0 } };
  const readJson = (file) => {
    const s = String(file);
    if (s.includes("live-execution-batch")) return { exists: true, ok: true, value: bundle };
    if (s.includes("fluid-l-watch-status")) return { exists: false, ok: false, value: null };
    if (s.includes("fluid-t2t4-fork-rehearsal")) return { exists: true, ok: true, value: rehearsal };
    if (s.includes("fluid-l-economics")) return { exists: true, ok: true, value: economics };
    return { exists: false, ok: false, value: null };
  };

  await trigger.runTrigger({
    argv: ["--execute"],
    executor: "0x000000000000000000000000000000000000dEaD", // non-placeholder so gate 0 passes
    readJson,
    loadExitDepthRows: () => new Map(),
    qualify: () => { providerCalled = true; return "provider"; },
    loadPrivateKey: () => { keyRead = true; return "0x" + "1".repeat(64); },
    log: (p) => { payload = p; },
    exit: (code) => ({ exited: code }),
  });

  assert.ok(payload, "a refusal payload must be produced");
  assert.equal(payload.ok, false);
  assert.equal(payload.firstFailure, "c");
  assert.equal(payload.keyRead, false);
  assert.equal(payload.networkWrite, false);
  assert.equal(keyRead, false, "private key must not be read");
  assert.equal(providerCalled, false, "provider qualification must not run");
  const gateA = payload.gates.find(g => g.id === "a");
  const gateB = payload.gates.find(g => g.id === "b");
  const gateC = payload.gates.find(g => g.id === "c");
  const gateD = payload.gates.find(g => g.id === "d");
  assert.equal(gateA.status, "pass");
  assert.equal(gateB.status, "pass");
  assert.equal(gateC.status, "fail");
  assert.match(gateC.detail, /mock-driven/);
  assert.equal(gateD.status, "skipped");
});

test("real CLI --execute refuses at gate 0 with keyRead/networkWrite false and no key/provider access", () => {
  let code = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "..", "execute-fluid-t2t4-trigger.js"), "--execute"], { encoding: "utf8" });
  } catch (e) {
    code = e.status;
    out = String(e.stdout || "");
  }
  assert.equal(code, 1);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.firstFailure, "0");
  assert.equal(parsed.keyRead, false);
  assert.equal(parsed.networkWrite, false);
});

test("no-feasible-row payload keeps the reason prefix, the full bounded probe log, and honest flags", () => {
  const probeLog = [
    { vault: ARB, chainId: 42161, skip: "chainId-not-ethereum(42161)" },
    { vault: BASE, chainId: 8453, skip: "chainId-not-ethereum(8453)" },
    { vault: ETH_UNSIZED, chainId: 1, skip: "exit-depth-unsized" },
    { vault: ETH_ELIGIBLE, chainId: 1, skip: "flash-balance-unreadable" },
  ];
  const gates = [
    { id: "0", status: "pass", detail: "executor" },
    { id: "a", status: "pass", detail: "batch" },
    { id: "b", status: "pass", detail: "economics" },
    { id: "c", status: "pass", detail: "rehearsal" },
    { id: "d", status: "pass", detail: "floors" },
  ];
  const payload = trigger.buildNoFeasibleRowPayload(probeLog, gates, { mode: "DRY_RUN", executor: "0xexec", keyRead: false });
  assert.match(payload.reason, /^no-feasible-row:/);
  assert.equal(payload.reason, "no-feasible-row:flash-balance-unreadable");
  assert.equal(payload.stage, "NO_FEASIBLE_ROW");
  assert.equal(payload.keyRead, false);
  assert.equal(payload.networkWrite, false);
  assert.equal(payload.rowSelection.length, 4, "all rejected reasons retained");
  assert.deepEqual(payload.rowSelection.map(r => r.skip), probeLog.map(r => r.skip));
  assert.equal(payload.gates.length, 5, "gate-level traces retained");
});

test("refresh restores the three scanner steps with no merge or rehearsal steps", () => {
  const calls = [];
  const store = { lastChainRunAt: new Date(Date.now() - 3_600_000).toISOString(), result: "OK", steps: [{ step: "surface-sync", rc: 0 }] };
  const io = {
    readStatus: () => store,
    writeStatus: (extra) => { Object.assign(store, extra); return store; },
    run: (_cmd, args) => { calls.push(args[0]); return { rc: 0, out: "ok" }; },
    now: () => Date.now(),
  };
  const status = refresh.runOnce(io);
  assert.deepEqual(calls, ["tools/scan-fluid-l.js", "tools/scan-fluid-l-economics.js", "tools/scan-fluid-l-economics-stage6.js"]);
  assert.equal(status.result, "OK");
  assert.deepEqual(status.steps.map(s => s.step), ["surface-sync", "economics-refresh", "stage6-exit-depth"]);
  assert.ok(!status.steps.some(s => /merge|rehearsal/i.test(s.step)));
  assert.equal(typeof refresh.mergeExitDepth, "undefined", "mergeExitDepth must be removed");
});

test("pacing skip preserves lastChainRunAt/result/steps and repeated skips never run scans", () => {
  let scans = 0;
  const lastChainRunAt = new Date(Date.now() - 60_000).toISOString();
  const store = { lastChainRunAt, result: "OK", steps: [{ step: "surface-sync", rc: 0 }] };
  const io = {
    readStatus: () => store,
    writeStatus: (extra) => { Object.assign(store, extra); return store; },
    run: () => { scans++; return { rc: 0, out: "" }; },
    now: () => Date.now(),
  };
  const r1 = refresh.runOnce(io);
  assert.equal(r1.skipped, "pacing");
  assert.equal(r1.lastChainRunAt, lastChainRunAt);
  assert.equal(r1.result, "OK");
  assert.deepEqual(r1.steps, [{ step: "surface-sync", rc: 0 }]);
  const r2 = refresh.runOnce(io);
  assert.equal(r2.skipped, "pacing");
  assert.equal(r2.lastChainRunAt, lastChainRunAt);
  assert.equal(r2.result, "OK");
  assert.equal(scans, 0, "a pacing skip must never run the scanner chain");
});

test("refresh records chain-failed with the failed step and still stamps lastChainRunAt", () => {
  const store = { lastChainRunAt: new Date(Date.now() - 3_600_000).toISOString(), result: "OK", steps: [] };
  const io = {
    readStatus: () => store,
    writeStatus: (extra) => { Object.assign(store, extra); return store; },
    run: (_cmd, args) => (args[0] === "tools/scan-fluid-l-economics.js" ? { rc: 2, out: "boom https://endpoint.example/?key=secret" } : { rc: 0, out: "ok" }),
    now: () => Date.now(),
  };
  const status = refresh.runOnce(io);
  assert.equal(status.result, "chain-failed");
  assert.equal(status.failedStep, "economics-refresh");
  assert.ok(status.lastChainRunAt);
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /https?:\/\/|key=secret/i, "scanner tail is redacted");
});
