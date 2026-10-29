"use strict";
// crossing-fluid-exec.test.js — offline tests for the Fluid crossing driver.
// No network, no anvil, no key reads. The live cycle is exercised through runOnce(deps)
// dependency injection (probe/run/qualify are fakes; writeStatus captures status).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const drv = require("../crossing-fluid-t2t4-exec.js");

const ETH_ROW = {
  routePositive: true,
  vault: "0x989a44cb4dbb7ebe20e0abf3c1e1d727bf90f881",
  chainId: 1,
  debtToken: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  colToken0: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
  colToken1: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  netUsdc: "2468000000",
  gasBoundUsdc: "10000000",
};
const OTHERCHAIN_ROW = { ...ETH_ROW, vault: "0x97950bf81f5605d2d0be37f28a33a752d6f16bdf", chainId: 42161, colToken1: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" };

function buildDeps(overrides = {}) {
  const statuses = [];
  let old = overrides.oldLastChainRunAt === undefined ? Date.now() - 61 * 60000 : overrides.oldLastChainRunAt;
  const deps = {
    recordedRuns: [],
    writeStatus: (b) => { statuses.push(b); return b; },
    readStatus: () => (old && old !== 0 ? { lastChainRunAt: new Date(old).toISOString(), result: "OK", steps: ["x"] } : null),
    run: (cmd, args, timeoutMs) => {
      deps.recordedRuns.push({ cmd, args, timeoutMs });
      const out = overrides.runResults && overrides.runResults[deps.recordedRuns.length - 1];
      return out === undefined ? { rc: 1, out: "{}" } : out;
    },
    lastJson: drv.lastJson,
    tryRead: (file) => overrides.tryRead ? overrides.tryRead(file) : { exists: false, ok: false, value: null },
    refreshStatusPath: "reports/raw/fast/fluid-l-surface-refresh-status.json",
    economicsTryRead: () => ({ exists: true, ok: true, value: overrides.economics || { rows: [] } }),
    loadRpcUrls: () => { throw new Error("no-network-in-tests"); },
    qualify: overrides.qualify || (async () => "https://url-never-used.invalid"),
    probeRow: overrides.probeRow || (async () => ({ liquidatable: false, reason: "liveness-unreadable", unreadable: true })),
    selectRows: drv.selectEligibleRows,
    ...overrides.deps,
  };
  return { deps, statuses, isOld: () => old };
}

test("pacing skip preserves lastChainRunAt/result/steps and performs zero chain steps", async () => {
  const { deps, statuses } = buildDeps({ oldLastChainRunAt: Date.now() - 60_000 });
  const res = await drv.runOnce(deps);
  assert.equal(res.state, "PACING_SKIP");
  assert.equal(res.code, 0);
  assert.equal(deps.recordedRuns.length, 0);
  const last = statuses[statuses.length - 1];
  assert.equal(last.result, "pacing");
  assert.equal(typeof last.lastChainRunAt, "string"); // preserved, not reset
  assert.equal(last.preservedResult, "OK");
});

test("refresh surface missing/unok fails closed before any step", async () => {
  const missing = buildDeps({});
  let res = await drv.runOnce(missing.deps);
  assert.equal(res.state, "REFRESH_SURFACE_UNAVAILABLE");
  assert.equal(res.code, 2);
  assert.equal(missing.deps.recordedRuns.length, 0);

  const unok = buildDeps({ deps: { tryRead: () => ({ exists: true, ok: true, value: { result: "chain-failed" } }) } });
  res = await drv.runOnce(unok.deps);
  assert.equal(res.state, "REFRESH_SURFACE_NOT_OK");
  assert.equal(res.code, 2);
  assert.equal(unok.deps.recordedRuns.length, 0);
});

test("no eligible ethereum rows -> NO_CANDIDATE (rc 0) without provider or rehearsal", async () => {
  const { deps, statuses } = buildDeps({
    deps: { tryRead: () => ({ exists: true, ok: true, value: { result: "OK" } }) },
    economics: { rows: [OTHERCHAIN_ROW] },
  });
  const res = await drv.runOnce(deps);
  assert.equal(res.state, "NO_CANDIDATE");
  assert.equal(res.code, 0);
  assert.equal(deps.recordedRuns.length, 0);
  const last = statuses[statuses.length - 1];
  assert.equal(last.result, "no-eligible-ethereum-row");
  assert.equal(typeof last.lastChainRunAt, "string");
});

test("eligible row with unreadable probe records the failure and still refuses firing", async () => {
  const { deps, statuses } = buildDeps({
    deps: { tryRead: () => ({ exists: true, ok: true, value: { result: "OK" } }) },
    economics: { rows: [ETH_ROW, OTHERCHAIN_ROW] },
    probeRow: async () => ({ liquidatable: false, reason: "liveness-unreadable", unreadable: true }),
  });
  const res = await drv.runOnce(deps);
  assert.equal(res.state, "NO_CANDIDATE_LIQUIDATABLE");
  assert.equal(res.code, 0);
  assert.equal(deps.recordedRuns.length, 0); // rehearsal/dry-run never reached
  const last = statuses[statuses.length - 1];
  assert.equal(last.result, "no-live-liquidatable-row");
  assert.equal(last.probes.length, 2); // probed eligible + rejected trace retained
  assert.equal(last.probes[0].vault, "0x989a44cb4dbb7ebe20e0abf3c1e1d727bf90f881");
  assert.equal(last.probes[0].reason, "liveness-unreadable");
  assert.equal(last.probes[1].vault, "0x97950bf81f5605d2d0be37f28a33a752d6f16bdf");
  assert.equal(last.probes[1].rejected, true);
  assert.equal(last.probes[1].reason, "chainId-not-ethereum(42161)");
});

test("liquidatable probe escalates to the real rehearsal; non-PASS refuses (rc 2)", async () => {
  const { deps, statuses } = buildDeps({
    deps: { tryRead: () => ({ exists: true, ok: true, value: { result: "OK" } }) },
    economics: { rows: [ETH_ROW] },
    probeRow: async () => ({ liquidatable: true, reason: "FluidLiquidateResult(col=5,debt=7)", debtLiquidated: "7" }),
    runResults: [{ rc: 1, out: JSON.stringify({ state: "FAIL", reason: "EXECUTE_STATIC_REVERTED", stage: "EXECUTE" }) }],
  });
  const res = await drv.runOnce(deps);
  assert.equal(res.state, "REHEARSAL_NOT_PASS");
  assert.equal(res.code, 2);
  assert.equal(deps.recordedRuns.length, 1);
  assert.deepEqual(deps.recordedRuns[0].args, ["tools/fluid-t2t4-fork-rehearsal-real.js"]);
  const last = statuses[statuses.length - 1];
  assert.equal(last.result, "rehearsal-not-pass");
  assert.equal(last.detail, "EXECUTE");
});

test("full positive chain: rehearsal PASS -> dry-run refused no-feasible-row is rc 0", async () => {
  const { deps } = buildDeps({
    deps: { tryRead: () => ({ exists: true, ok: true, value: { result: "OK" } }) },
    economics: { rows: [ETH_ROW] },
    probeRow: async () => ({ liquidatable: true, reason: "FluidLiquidateResult(col=5,debt=7)", debtLiquidated: "7" }),
    runResults: [
      { rc: 0, out: JSON.stringify({ state: "PASS", summary: { pass: 1, failClosed: 0 } }) },
      { rc: 1, out: JSON.stringify({ ok: false, reason: "no-feasible-row:exit-depth-unsized", keyRead: false, networkWrite: false }) },
    ],
  });
  const res = await drv.runOnce(deps);
  assert.equal(res.state, "DRY_RUN_FAIL");
  assert.equal(res.code, 0);
  assert.equal(deps.recordedRuns.length, 2);
  assert.deepEqual(deps.recordedRuns[1].args.slice(0, 1), ["tools/execute-fluid-t2t4-trigger.js"]);
  assert.deepEqual(deps.recordedRuns[1].args[deps.recordedRuns[1].args.length - 1], "--dry-run");
  assert.equal(deps.recordedRuns.some((r) => r.args.includes("--execute")), false);
});

test("driver status writes carry no urls/priva-secrets/pin hashes", async () => {
  const { deps, statuses } = buildDeps({
    deps: { tryRead: () => ({ exists: true, ok: true, value: { result: "OK" } }) },
    economics: { rows: [] },
  });
  await drv.runOnce(deps);
  const encoded = JSON.stringify(statuses);
  assert.doesNotMatch(encoded, /https?:\/\//i);
  assert.doesNotMatch(encoded, /secret\.example|private-marker/i);
  assert.doesNotMatch(encoded, /0x[0-9a-f]{64}/i);
});

test("status path and gateway args match the euler-parity contract", () => {
  assert.equal(drv.STATUS.replace(/\\/g, "/"), "reports/raw/fast/fluid-crossing-exec-status.json");
  assert.deepEqual(drv.RUNNER_ARGS.slice(0, 1), ["tools/execute-fluid-t2t4-trigger.js"]);
  assert.equal(drv.REHEARSAL_SCRIPT, "tools/fluid-t2t4-fork-rehearsal-real.js");
});
