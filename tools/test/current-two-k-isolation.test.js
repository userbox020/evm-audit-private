"use strict";

// Offline admission/preparation only. No real guard, journal, wallet, RPC or process work.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { compileFunction } = require("node:vm");
const { createRequire } = require("node:module");
const guard = require("../lib/wallet-execution-guard.js"), m1 = require("../lib/m1-live-evidence.js");
const FILE = path.resolve(__dirname, "../execute-top-whale-trigger.js"), SOURCE = fs.readFileSync(FILE, "utf8"), native = createRequire(FILE);
const W = 10n ** 18n, ZERO = "0x" + "00".repeat(20), NOW = Date.parse("2026-10-28T07:00:00Z");
const PIN = { chainId: 1, number: 1000, hash: "0x" + "11".repeat(32), timestamp: NOW / 1000 - 3, baseFeePerGas: "1" };
const ID = "target2K_AaveV3_WETH_WETH_0x7a05", BORROWER = "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3", FLAG = "--current-only-2k";
const denied = () => assert.fail("offline isolation fixture forbids external or unrelated work");
function address(name) {
  const match = SOURCE.match(new RegExp(`\\b${name} = "(0x[0-9a-f]+)"`));
  assert.ok(match, name); return match[1];
}
function loadRunner() {
  const module = { exports: {} }, fixtureFs = new Proxy({}, { get: () => denied });
  const req = name => name === "node:fs" ? fixtureFs : name === "./lib/m32-attended-call.cjs" ? denied() : native(name);
  compileFunction(SOURCE.replace(/^#![^\n]*\n/, ""), ["require", "module", "exports", "__dirname", "__filename", "fetch"], { filename: FILE })
    (req, module, module.exports, path.dirname(FILE), FILE, denied);
  return module.exports;
}
function twoKRow(api, liquidatableNow, monitor = true) {
  const params = { isAaveV3: true, target: address("POOL"), borrower: BORROWER, debtToken: address("WETH"), collateralToken: address("WETH"),
    collateralReserveId: 0, debtReserveId: 0, minCollateralSeized: 0, swapKind: 0, swapTarget: ZERO, swapSpender: ZERO,
    uniFee: 0, curveI: 0, curveJ: 0, minDebtTokenOut: 0, minProfitDebtToken: W / 100n };
  return { rank: "#2K", user: BORROWER, pool: address("POOL"), observationOnly: false, armed: true,
    liquidatableNow, executableNow: liquidatableNow, healthFactor: liquidatableNow ? 0.9999 : 1.0001, debtUsd: 13000,
    readyExecuteMorphoCalldata: api.UNIFIED_IFACE.encodeFunctionData("executeMorpho", [5400000000000000000n, params]),
    ...(monitor ? { observationKind: "READ_ONLY_MONITOR", observationOnly: true, armed: false, executableNow: false,
      eligibleForPreflight: liquidatableNow, observationStatus: "COMPLETE", refreshStatus: "COMPLETE", chainId: 1,
      observationBlock: PIN.number, observationHash: PIN.hash, observationTimestamp: PIN.timestamp } : {}) };
}
function unrelatedRows(api) {
  const { key, borrower } = api.V3_TARGETS[0], irm = address("M1_IRM");
  const row = (user, field, data) => ({ user, liquidatableNow: true, executableNow: true, positionStatus: "OPEN", debtRaw: "1", [field]: data });
  return {
    [key]: row(borrower, "readyExecuteMorphoCalldata", api.UNIFIED_IFACE.encodeFunctionData("executeMorpho", [W,
      { isAaveV3: true, target: address("POOL"), borrower, debtToken: address("WETH"), collateralToken: address("WEETH"),
        collateralReserveId: 0, debtReserveId: 0, minCollateralSeized: 2n * W, swapKind: 2, swapTarget: address("CURVE"),
        swapSpender: address("CURVE"), uniFee: 0, curveI: 1, curveJ: 0, minDebtTokenOut: 101n * W / 100n, minProfitDebtToken: W / 100n }])),
    targetM1_Morpho_USDe_DAI: row(address("M1_BORROWER"), "readyExecuteMorphoBlueCalldata", api.MORPHO_EXEC_IFACE.encodeFunctionData("execute",
      [{ loanToken: address("DAI"), collateralToken: address("USDE"), oracle: address("M1_ORACLE"), irm, lltv: 860000000000000000n },
        address("M1_BORROWER"), 100000n * W, 0, 25n * W, 100100n * W, address("UNI_ROUTER"), address("M1_PATH")])),
    targetM2_Morpho_reUSD_USDC: row(address("M2_BORROWER"), "readyExecuteCurveUnwindCalldata", api.M2_EXEC_IFACE.encodeFunctionData("execute",
      [{ loanToken: address("USDC"), collateralToken: address("REUSD"), oracle: address("M2_ORACLE"), irm, lltv: 915000000000000000n,
        borrower: address("M2_BORROWER"), seizedAssets: 100000n * W, swapTarget: address("CURVE_REUSD_USDC"), minLoanOut: 100025000000n },
        api.CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, 100000n * W, 107460000000n])])),
  };
}
function batch(api) {
  return { schema: "live-execution-batch/v1", approved: true, approvedAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 60000).toISOString(), chainId: 1, chain: "ethereum",
    account: { address: guard.MAIN_ACCOUNT }, targets: api.REQUIRED_TARGETS.map(address => ({ address })),
    actions: ["liquidator.executeMorpho(uint256 flashAmount, UnifiedLiquidationParams params) when net > 0"],
    caps: { maxExecutionGasLimit: 1500000, maxExecutionSpendWei: "2000000000000000", signedExecutionsPerDay: 3,
      slippageFloor: "minDebtTokenOut >= quoted * 0.995; minProfitDebtToken > 0", principalAtRisk: "zero (atomic settlement)" } };
}
function harness(t, { liquidatableNow = false, monitor = true, scoped = true } = {}) {
  const writes = t.mock.method(guard, "atomicJson", () => {}), reconcile = t.mock.method(guard, "reconcileWallet", async () => {});
  const forbidden = [t.mock.method(guard, "acquireWalletLock", denied), t.mock.method(guard, "signWithProcessKey", denied),
    t.mock.method(m1, "strictContext", denied), t.mock.method(m1, "executeM1", denied)];
  const api = loadRunner(), approved = batch(api), state = { prepared: null, intent: null, prepares: 0 };
  const fees = t.mock.method(guard, "buildFees", guard.buildFees);
  const execution = t.mock.method(guard, "executeGuarded", async options => {
    state.prepares++; state.prepared = await options.prepare(); state.intent = options.intent;
    return { stage: "PREPARED" }; // Deliberately stops before the actual guard/journal/signing boundary.
  });
  const targets = { ...unrelatedRows(api), [ID]: twoKRow(api, liquidatableNow, monitor) };
  const pinned = { pin: { ...PIN }, evidence: {}, assertUsable: t.mock.fn(), recheck: t.mock.fn(async () => {}),
    call: t.mock.fn(async call => {
      if (call.to === address("CURVE")) {
        const [, , input] = api.CURVE_IFACE.decodeFunctionData("get_dy", call.data);
        return api.CURVE_IFACE.encodeFunctionResult("get_dy", [input * 101n / 200n]);
      }
      assert.equal(call.to, api.DEPLOYED_EXECUTOR); return "0x";
     }), estimateGas: t.mock.fn(async () => 100000n),
     nonce: t.mock.fn(async account => { assert.equal(account, guard.MAIN_ACCOUNT); return "0x7"; }),
     balance: t.mock.fn(async account => { assert.equal(account, guard.MAIN_ACCOUNT); return "0x" + (2n * W).toString(16); }),
     send: t.mock.fn(denied), receipt: t.mock.fn(denied) };
  const inputs = { execute: true, argv: scoped ? [FLAG, "--no-write"] : ["--no-write"], now: () => NOW, pinned,
    loadBatch: t.mock.fn(() => approved), loadMorphoBatch: t.mock.fn(denied), amendmentReadFile: t.mock.fn(denied), m1ReadFile: t.mock.fn(denied),
    signTransaction: t.mock.fn(denied), secondarySendRawTransaction: t.mock.fn(denied),
    checkOnce: t.mock.fn(async options => ({ pin: pinned.pin, targets: options.m1Only ? {} : targets })) };
  const noIrreversible = () => {
    for (const spy of [...forbidden, inputs.loadMorphoBatch, inputs.amendmentReadFile, inputs.m1ReadFile,
      inputs.signTransaction, inputs.secondarySendRawTransaction, pinned.send, pinned.receipt]) assert.equal(spy.mock.callCount(), 0);
  };
  const noTransaction = () => {
    noIrreversible();
    for (const spy of [pinned.call, pinned.estimateGas, pinned.nonce, pinned.balance, fees, execution]) assert.equal(spy.mock.callCount(), 0);
    assert.deepEqual(state, { prepared: null, intent: null, prepares: 0 });
  };
  return { api, inputs, targets, pinned, approved, state, writes, reconcile, fees, execution, noIrreversible, noTransaction,
    run: overrides => api.runPass({ ...inputs, ...overrides }) };
}
function assertScope(summary) {
  assert.equal(summary.collectionScope, "CURRENT_2K_ONLY"); assert.equal(summary.partition, "CURRENT_2K_ONLY");
}
function assertOneCollection(h) {
  assert.equal(h.inputs.checkOnce.mock.callCount(), 1);
  assert.equal(h.inputs.checkOnce.mock.calls[0].arguments[0].m1Only, false);
  assert.equal(h.inputs.checkOnce.mock.calls[0].arguments[0].nextBlockContext, null);
}

for (const monitor of [false, true]) {
  const label = monitor ? "canonical observationOnly monitor" : "raw producer";
  test(`CURRENT 2K only: healthy ${label} ignores eligible M1/stable/unified rows`, async t => {
    const h = harness(t, { monitor });
    assert.equal(h.api.selectCandidates({ targets: unrelatedRows(h.api) }).length, 3, "unrelated fixtures really nominate candidates");
    h.targets[ID].nextBlockForecast = { eligibleForSimulation: true, evidence: "FORECAST_ONLY" };
    const out = await h.run();
    assertScope(out.summary); assert.equal(out.fired, false); assert.equal(out.summary.ok, true); assert.equal(out.summary.armed, true);
    assert.equal(out.summary.localMaxSpendWei, undefined, "no budget is implied when the optional flag is absent");
    assert.equal(out.summary.candidateCount, 0); assert.equal(out.summary.mode, "EXECUTE_IF_LIQUIDATABLE");
    assert.equal(out.summary.reason, undefined); assert.equal(out.summary.execution, undefined); assert.equal(out.summary.preflightFailures, undefined);
    assert.deepEqual(out.summary.targets.map(row => row.user), [BORROWER]); assert.equal(out.summary.targets[0].nextBlockForecast, undefined);
    assert.equal(out.summary.phaseTimingsMs.focusedM1Collection, null); assert.equal(h.reconcile.mock.callCount(), 1);
    assert.equal(h.inputs.loadBatch.mock.callCount(), 2); assertOneCollection(h); h.noTransaction();
  });

  test(`CURRENT 2K only: eligible ${label} prepares only the exact 5.40 WETH plan`, async t => {
    const h = harness(t, { monitor, liquidatableNow: true }), out = await h.run();
    assertScope(out.summary); assert.equal(out.fired, true); assert.equal(out.summary.armed, false); assert.equal(out.summary.candidateCount, 1);
    assert.deepEqual(out.summary.execution, { stage: "PREPARED" }); assert.deepEqual(out.summary.targets.map(row => row.user), [BORROWER]);
    assert.equal(h.state.prepares, 1); assert.equal(h.execution.mock.callCount(), 1); assert.equal(h.pinned.nonce.mock.callCount(), 1);
    const tx = h.state.prepared.transaction, [flash, p] = h.api.UNIFIED_IFACE.decodeFunctionData("executeMorpho", tx.data), floor = W / 100n;
    assert.equal(flash, 5400000000000000000n); assert.equal(p.isAaveV3, true);
    assert.deepEqual([p.borrower, p.target, p.debtToken, p.collateralToken].map(a => a.toLowerCase()), [BORROWER, address("POOL"), address("WETH"), address("WETH")]);
    assert.deepEqual([p.swapKind, p.minDebtTokenOut, p.minCollateralSeized, p.collateralReserveId, p.debtReserveId, p.uniFee, p.curveI, p.curveJ], Array(8).fill(0n));
    assert.equal(p.swapTarget, ZERO); assert.equal(p.swapSpender, ZERO); assert.equal(p.minProfitDebtToken, floor);
    assert.equal(h.fees.mock.callCount(), 1);
    assert.deepEqual(h.fees.mock.calls[0].arguments, [100000n, PIN.baseFeePerGas, h.api.validateAuthorization(h.approved, NOW), floor]);
    assert.equal(h.state.prepared.conservativeProfitBeforeGasWei, floor.toString()); assert.equal(h.state.intent.minProfitBeforeGasRaw, floor.toString());
    assert.equal(h.state.intent.targetId, ID);
    assert.deepEqual(tx, { type: 2, chainId: 1, nonce: 7, to: h.api.DEPLOYED_EXECUTOR, value: 0n,
      data: h.targets[ID].readyExecuteMorphoCalldata, ...h.fees.mock.calls[0].result });
    const call = { from: guard.MAIN_ACCOUNT, to: tx.to, data: tx.data };
    assert.deepEqual(h.pinned.call.mock.calls.map(c => c.arguments), [[call]]); assert.deepEqual(h.pinned.estimateGas.mock.calls.map(c => c.arguments), [[call]]);
    assert.ok(floor > tx.gasLimit * tx.maxFeePerGas); assertOneCollection(h); h.noIrreversible();
  });
}

for (const [label, change] of [
  ["missing row", null], ["retained row", { refreshStatus: "INCOMPLETE" }], ["explicit retention", { retained: true }],
  ["observation-only without canonical provenance", { observationKind: undefined }], ["inactive", { inactive: true }],
  ["unknown position", { positionStatus: "UNKNOWN" }], ["unknown debt", { debtReadStatus: "UNAVAILABLE" }],
  ["zero debt", { debtUsd: 0 }], ["missing debt", { debtUsd: undefined }], ["invalid raw debt", { debtRaw: "unknown" }],
  ["missing health", { healthFactor: undefined }], ["nonfinite health", { healthFactor: NaN }],
  ["contradictory health", { healthFactor: 0.9999 }], ["unknown eligibility", { liquidatableNow: undefined }],
  ["missing plan", { readyExecuteMorphoCalldata: undefined }], ["wrong borrower", { user: ZERO }], ["wrong pool", { pool: ZERO }],
  ["stale row pin", { observationBlock: PIN.number - 1 }], ["missing row hash", { observationHash: undefined }],
  ["failed observation", { observationStatus: "UNAVAILABLE" }], ["contradictory nomination", { eligibleForPreflight: true }],
]) {
  test(`CURRENT 2K only: ${label} cannot become armed healthy waiting`, async t => {
    const h = harness(t);
    if (change === null) delete h.targets[ID]; else Object.assign(h.targets[ID], change);
    await assert.rejects(h.run(), error => {
      assert.equal(error.code, "CURRENT_2K_EVIDENCE_REQUIRED"); assertScope(error.passSummary);
      assert.equal(error.passSummary.armed, false); assert.equal(error.passSummary.ok, false); return true;
    });
    assert.equal(h.reconcile.mock.callCount(), 0); assertOneCollection(h); h.noTransaction();
  });
}

for (const flag of ["--m1-only", "--next-block", "--measure-only", "--reuse-qualified-pair", "--m1-hot-path-v2",
  "--m1-ws-heads", "--m1-capability-v1", "--m32-only", "--m32-warm-watch"]) {
  test(`CURRENT 2K only: ${flag} rejects before main dispatch or runPass authorization`, async t => {
    const h = harness(t), argv = [FLAG, flag];
    const rejects = error => error.code === "CURRENT_2K_MODE_CONFLICT" && error.message === "CURRENT_2K_MODE_CONFLICT";
    assert.throws(() => h.api.parseRunnerMode(argv), rejects);
    await assert.rejects(h.api.main(argv, new Proxy({}, { get: denied })), rejects);
    await assert.rejects(h.run({ argv, pinned: new Proxy({}, { get: denied }) }), rejects);
    assert.equal(h.inputs.loadBatch.mock.callCount(), 0); assert.equal(h.inputs.checkOnce.mock.callCount(), 0);
    assert.equal(h.reconcile.mock.callCount(), 0); h.noTransaction();
  });
}
for (const option of ["allowFutureContinuation", "futureContinuationOwner", "hotPathLease", "hotPathTimings", "m1Budget"]) {
  test(`CURRENT 2K only: injected ${option} rejects before any dependency work`, async t => {
    const h = harness(t);
    await assert.rejects(h.run({ [option]: option === "allowFutureContinuation" ? true : {} }), { code: "CURRENT_2K_MODE_CONFLICT" });
    assert.equal(h.inputs.loadBatch.mock.callCount(), 0); assert.equal(h.inputs.checkOnce.mock.callCount(), 0);
    assert.equal(h.reconcile.mock.callCount(), 0); h.noTransaction();
  });
}

for (const [label, code] of [["partial collection", "BROAD_COLLECTION_PARTIAL"], ["wrong collection pin", "COLLECTOR_PIN_MISMATCH"],
  ["failed recheck", "PIN_EVIDENCE_INVALIDATED"], ["invalidated context", "PIN_EVIDENCE_INVALIDATED"]]) {
  test(`CURRENT 2K only: ${label} retains the existing freshness hold`, async t => {
    const h = harness(t);
    if (label === "failed recheck") h.pinned.recheck.mock.mockImplementation(async () => { throw new guard.ExecutionError(code); });
    else if (label === "invalidated context") h.pinned.assertUsable.mock.mockImplementation(() => { throw new guard.ExecutionError(code); });
    else h.inputs.checkOnce.mock.mockImplementation(async () => ({ targets: h.targets, partial: label === "partial collection",
      pin: label === "wrong collection pin" ? { ...PIN, number: PIN.number + 1 } : PIN }));
    await assert.rejects(h.run(), error => error.code === code && error.passSummary.armed === false);
    assert.equal(h.reconcile.mock.callCount(), 0); h.noTransaction();
  });
}

test("CURRENT 2K only: healthy waiting still requires initial and renewed authorization plus reconciliation", async t => {
  const h = harness(t);
  await assert.rejects(h.run({ batch: { ...h.approved, expiresAt: new Date(NOW).toISOString() } }), { code: "BATCH_INVALID_OR_EXPIRED" });
  assert.equal(h.inputs.checkOnce.mock.callCount(), 0); assert.equal(h.reconcile.mock.callCount(), 0);
  let loads = 0;
  h.inputs.loadBatch.mock.mockImplementation(() => ++loads === 1 ? h.approved : { ...h.approved, revoked: true });
  await assert.rejects(h.run(), error => error.code === "BATCH_INVALID_OR_EXPIRED" && error.passSummary.armed === false);
  assert.equal(h.reconcile.mock.callCount(), 1); assert.equal(loads, 2); h.noTransaction();
});
test("CURRENT 2K only: reconciliation failure cannot report armed waiting", async t => {
  const h = harness(t);
  h.reconcile.mock.mockImplementation(async () => { throw new guard.ExecutionError("WALLET_RECONCILIATION_REQUIRED"); });
  await assert.rejects(h.run(), error => error.code === "WALLET_RECONCILIATION_REQUIRED" && error.passSummary.armed === false);
  h.noTransaction();
});
test("CURRENT 2K only: normal status writes never overwrite the shared observation artifact", async t => {
  const h = harness(t), out = await h.run({ argv: [FLAG], writeOut: true, statusFile: "offline-status", observationFile: "shared-observation" });
  assert.deepEqual(h.writes.mock.calls.map(c => c.arguments), [["offline-status", out.summary]]); h.noTransaction();
});
test("CURRENT 2K only: unchanged selector rejects a modified exact flash amount", async t => {
  const h = harness(t, { liquidatableNow: true }), decoded = h.api.UNIFIED_IFACE.decodeFunctionData("executeMorpho", h.targets[ID].readyExecuteMorphoCalldata);
  h.targets[ID].readyExecuteMorphoCalldata = h.api.UNIFIED_IFACE.encodeFunctionData("executeMorpho", [W, decoded[1]]);
  await assert.rejects(h.run(), error => error.code === "EXECUTION_ROUTE_NOT_ALLOWED" && error.passSummary.armed === false);
  assert.equal(h.reconcile.mock.callCount(), 0); h.noTransaction();
});
test("default mode: focused collection and unrelated Unified preparation remain unchanged", async t => {
  const h = harness(t, { scoped: false }), key = h.api.V3_TARGETS[0].key;
  for (const id of Object.keys(h.targets)) if (id !== key) delete h.targets[id];
  const out = await h.run();
  assert.equal(out.fired, true); assert.equal(out.summary.collectionScope, undefined); assert.equal(out.summary.partition, "V3_ONLY");
  assert.equal(h.inputs.checkOnce.mock.callCount(), 2); assert.equal(h.inputs.checkOnce.mock.calls[0].arguments[0].m1Only, true);
  assert.equal(h.pinned.balance.mock.callCount(), 0);
  assert.equal(h.state.intent.targetId, key); assert.equal(h.state.prepares, 1); h.noIrreversible();
});

const SPEND_FLAG = "--current-2k-max-spend-wei";
// Retained LOCAL measurement as a synthetic regression input, not an operational wallet balance/budget.
const LOCAL_CEILING = 854826828899120n;
const budgetArgv = value => [FLAG, SPEND_FLAG, value.toString(), "--no-write"];
test("CURRENT 2K budget: LOCAL 451345 estimate constrains actual prepare and final validation without changing approval", async t => {
  const h = harness(t, { liquidatableNow: true }), original = JSON.stringify(h.approved);
  Object.freeze(h.approved.caps); Object.freeze(h.approved);
  h.pinned.estimateGas.mock.mockImplementation(async () => 451345n);
  const out = await h.run({ argv: budgetArgv(LOCAL_CEILING) }), floor = W / 100n;
  const expectedCaps = { ...h.api.validateAuthorization(h.approved, NOW), spendCap: LOCAL_CEILING };
  assertScope(out.summary); assert.equal(out.fired, true); assert.equal(out.summary.localMaxSpendWei, LOCAL_CEILING.toString());
  assert.deepEqual(out.summary.execution, { stage: "PREPARED" });
  assert.deepEqual(h.fees.mock.calls[0].arguments, [451345n, PIN.baseFeePerGas, expectedCaps, floor]);
  assert.equal(h.fees.mock.callCount(), 1); assert.deepEqual(h.state.prepared.caps, expectedCaps);
  const tx = h.state.prepared.transaction, liability = tx.gasLimit * tx.maxFeePerGas;
  assert.equal(tx.gasLimit, 541614n); assert.equal(tx.maxFeePerGas, 1578295296n); assert.equal(liability, 854826828447744n);
  assert.ok(liability <= LOCAL_CEILING && LOCAL_CEILING < BigInt(h.approved.caps.maxExecutionSpendWei));
  assert.equal(floor - liability, 9145173171552256n);
  assert.equal(h.state.prepared.conservativeProfitBeforeGasWei, floor.toString()); assert.equal(h.state.intent.minProfitBeforeGasRaw, floor.toString());
  assert.equal(h.state.intent.targetId, ID); assert.equal(tx.data, h.targets[ID].readyExecuteMorphoCalldata);
  assert.equal(tx.nonce, 7); assert.equal(h.pinned.nonce.mock.callCount(), 1); assert.equal(h.state.prepares, 1);
  const options = h.execution.mock.calls[0].arguments[0];
  assert.deepEqual(await options.validate(), expectedCaps, "actual guard callback retains the local ceiling");
  const refreshed = { ...h.approved, caps: { ...h.approved.caps, maxExecutionGasLimit: 1400000,
    maxExecutionSpendWei: "1000000000000000", signedExecutionsPerDay: 2, signedExecutionsTotal: 1 } };
  h.inputs.loadBatch.mock.mockImplementation(() => refreshed);
  const finalCaps = await options.validate();
  assert.deepEqual(finalCaps, { ...h.api.validateAuthorization(refreshed, NOW), spendCap: LOCAL_CEILING });
  guard.validateTransaction(tx, finalCaps); // Pure cap check only, never the real guard/journal/signer.
  assert.throws(() => guard.validateTransaction({ ...tx, maxFeePerGas: tx.maxFeePerGas + 1n }, finalCaps), { code: "TX_CAP_EXCEEDED" });
  assert.equal(JSON.stringify(h.approved), original); assert.equal(refreshed.caps.maxExecutionSpendWei, "1000000000000000");
  assertOneCollection(h); h.noIrreversible();
});
for (const ceiling of [LOCAL_CEILING, 2000000000000000n]) {
  test(`CURRENT 2K budget: healthy waiting accepts explicit ${ceiling} wei without transaction work`, async t => {
    const h = harness(t), original = JSON.stringify(h.approved), out = await h.run({ argv: budgetArgv(ceiling) });
    assertScope(out.summary); assert.equal(out.fired, false); assert.equal(out.summary.armed, true); assert.equal(out.summary.candidateCount, 0);
    assert.equal(out.summary.localMaxSpendWei, ceiling.toString()); assert.equal(h.inputs.loadBatch.mock.callCount(), 2);
    assert.equal(h.reconcile.mock.callCount(), 1); assert.equal(JSON.stringify(h.approved), original); h.noTransaction();
  });
}

for (const [label, argv] of [
  ["missing", [FLAG, SPEND_FLAG]], ["duplicate", [FLAG, SPEND_FLAG, "1", SPEND_FLAG, "2"]],
  ["unscoped", [SPEND_FLAG, "1"]], ["unscoped special dispatch", ["--m32-only", SPEND_FLAG, "1"]],
  ["equals syntax", [FLAG, `${SPEND_FLAG}=1`]],
  ...[["empty", ""], ["zero", "0"], ["negative", "-1"], ["signed", "+1"], ["fraction", "1.5"], ["exponent", "1e3"],
    ["hex", "0x1"], ["leading zero", "01"], ["whitespace", " 1"], ["trailing whitespace", "1 "], ["NaN", "NaN"], ["infinite", "Infinity"],
    ["number", 1], ["bigint", 1n], ["boolean", true], ["null", null], ["object", {}], ["array", ["1"]],
    ["uint256 overflow", (1n << 256n).toString()]].map(([label, value]) => [label, [FLAG, SPEND_FLAG, value]]),
]) {
  test(`CURRENT 2K budget: ${label} rejects before main or runPass dependency work`, async t => {
    const h = harness(t), rejects = error => error.code === "CURRENT_2K_MAX_SPEND_INVALID" && error.message === "CURRENT_2K_MAX_SPEND_INVALID";
    assert.throws(() => h.api.parseRunnerMode(argv), rejects);
    await assert.rejects(h.api.main(argv, new Proxy({}, { get: denied })), rejects);
    await assert.rejects(h.run({ argv, pinned: new Proxy({}, { get: denied }) }), rejects);
    assert.equal(h.inputs.loadBatch.mock.callCount(), 0); assert.equal(h.inputs.checkOnce.mock.callCount(), 0);
    assert.equal(h.reconcile.mock.callCount(), 0); h.noTransaction();
  });
}
for (const execute of [false, true]) {
  test(`CURRENT 2K budget: over-authorized ceiling rejects before collection with execute=${execute}`, async t => {
    const h = harness(t), original = JSON.stringify(h.approved);
    await assert.rejects(h.run({ execute, argv: budgetArgv(BigInt(h.approved.caps.maxExecutionSpendWei) + 1n) }), error =>
      error.code === "CURRENT_2K_MAX_SPEND_EXCEEDS_AUTHORIZATION" && error.passSummary.armed === false);
    assert.equal(h.inputs.checkOnce.mock.callCount(), 0); assert.equal(h.reconcile.mock.callCount(), 0);
    assert.equal(JSON.stringify(h.approved), original); h.noTransaction();
  });
}
test("CURRENT 2K budget: main rejects an over-authorized ceiling before provider acquisition", async t => {
  const h = harness(t), output = t.mock.fn();
  t.mock.method(Date, "now", () => NOW);
  await h.api.main([...budgetArgv(BigInt(h.approved.caps.maxExecutionSpendWei) + 1n), "--execute", "--watch", "5", "--max-runs", "1"],
    { loadBatch: h.inputs.loadBatch, loadCandidates: denied, connect: denied, runPass: denied, output });
  assert.equal(output.mock.callCount(), 1);
  const summary = output.mock.calls[0].arguments[0];
  assertScope(summary); assert.equal(summary.armed, false); assert.equal(summary.reason, "CURRENT_2K_MAX_SPEND_EXCEEDS_AUTHORIZATION");
  assert.equal(summary.localMaxSpendWei, "2000000000000001"); h.noTransaction();
});

const changedApprovals = [
  ["tighter spend cap", approval => ({ ...approval, caps: { ...approval.caps, maxExecutionSpendWei: (LOCAL_CEILING - 1n).toString() } }), "CURRENT_2K_MAX_SPEND_EXCEEDS_AUTHORIZATION"],
  ["revoked", approval => ({ ...approval, revoked: true }), "BATCH_INVALID_OR_EXPIRED"],
  ["expired", approval => ({ ...approval, expiresAt: new Date(NOW).toISOString() }), "BATCH_INVALID_OR_EXPIRED"],
];
for (const [phase, read] of [["healthy waiting refresh", 2], ["prepare validation", 4], ["prepare post-recheck", 5],
  ["returned prepare caps", 6], ["final guard validation", 7], ["final guard post-recheck", 8]]) {
  for (const [change, changeApproval, code] of changedApprovals) {
    test(`CURRENT 2K budget: ${change} at ${phase} cannot bypass live authorization`, async t => {
      const h = harness(t, { liquidatableNow: read !== 2 }), original = JSON.stringify(h.approved), changed = changeApproval(h.approved);
      let reads = 0;
      h.inputs.loadBatch.mock.mockImplementation(() => ++reads >= read ? changed : h.approved);
      if (read >= 7) h.execution.mock.mockImplementation(async options => {
        h.state.prepares++; h.state.prepared = await options.prepare(); h.state.intent = options.intent;
        await options.validate(); return { stage: "PREPARED" };
      });
      await assert.rejects(h.run({ argv: budgetArgv(LOCAL_CEILING) }), error => error.code === code && error.passSummary.armed === false);
      assert.equal(reads, read); assert.equal(h.pinned.nonce.mock.callCount(), read >= 6 ? 1 : 0);
      if (h.state.prepared) assert.equal(h.state.prepared.caps.spendCap, LOCAL_CEILING);
      if (read === 2) h.noTransaction(); else h.noIrreversible();
      assert.equal(JSON.stringify(h.approved), original);
    });
  }
}
for (const [change, changeApproval] of changedApprovals.slice(1)) {
  test(`CURRENT 2K budget: initially ${change} authorization is not rescued by a lower budget`, async t => {
    const h = harness(t), invalid = changeApproval({ ...h.approved, caps: { ...h.approved.caps, maxExecutionSpendWei: "1" } });
    await assert.rejects(h.run({ batch: invalid, argv: budgetArgv(LOCAL_CEILING) }), { code: "BATCH_INVALID_OR_EXPIRED" });
    assert.equal(h.inputs.checkOnce.mock.callCount(), 0); assert.equal(h.reconcile.mock.callCount(), 0); h.noTransaction();
  });
}
test("CURRENT 2K budget: CLI still uses --execute, not --execute-if-liquidatable", async t => {
  const h = harness(t), argv = [...budgetArgv(LOCAL_CEILING), "--watch", "5"];
  assert.equal(h.api.parseRunnerMode([...argv, "--execute"]).execute, true);
  assert.throws(() => h.api.parseRunnerMode([...argv, "--execute-if-liquidatable"]), { code: "UNSUPPORTED_EXECUTION_FLAG" });
  h.noTransaction();
});

for (const ceiling of [null, 750000000000000n]) {
  test(`CURRENT 2K native balance: pricing attenuates approval${ceiling === null ? "" : " and CLI"} without changing final authority caps`, async t => {
    const h = harness(t, { liquidatableNow: true }), original = JSON.stringify(h.approved);
    Object.freeze(h.approved.caps); Object.freeze(h.approved);
    const balance = ceiling === null ? LOCAL_CEILING : 700000000000000n;
    h.pinned.balance.mock.mockImplementation(async account => {
      assert.equal(account, guard.MAIN_ACCOUNT); return "0x" + balance.toString(16);
    });
    h.pinned.estimateGas.mock.mockImplementation(async () => 451345n);
    const out = await h.run(ceiling === null ? {} : { argv: budgetArgv(ceiling) });
    const approvedCaps = h.api.validateAuthorization(h.approved, NOW), finalCaps = ceiling === null ? approvedCaps : { ...approvedCaps, spendCap: ceiling };
    assert.equal(out.fired, true);
    assert.deepEqual(h.fees.mock.calls[0].arguments, [451345n, PIN.baseFeePerGas, { ...finalCaps, spendCap: balance }, W / 100n]);
    assert.deepEqual(h.state.prepared.caps, finalCaps, "balance is a pricing restriction, not rewritten authority");
    const tx = h.state.prepared.transaction;
    assert.equal(tx.gasLimit, 541614n); assert.ok(tx.gasLimit * tx.maxFeePerGas <= balance);
    assert.ok(W / 100n > tx.gasLimit * tx.maxFeePerGas);
    assert.equal(tx.data, h.targets[ID].readyExecuteMorphoCalldata);
    assert.equal(h.api.UNIFIED_IFACE.decodeFunctionData("executeMorpho", tx.data)[0], 5400000000000000000n);
    assert.equal(h.fees.mock.callCount(), 1); assert.equal(h.pinned.balance.mock.callCount(), 2);
    assert.equal(JSON.stringify(h.approved), original); h.noIrreversible();
  });
}

test("CURRENT 2K native balance: pricing reloads approval rather than using pass-entry caps", async t => {
  const h = harness(t, { liquidatableNow: true }), original = JSON.stringify(h.approved);
  const refreshed = { ...h.approved, caps: { ...h.approved.caps, maxExecutionSpendWei: "500000000000000", signedExecutionsPerDay: 2 } };
  Object.freeze(refreshed.caps); Object.freeze(refreshed);
  let reads = 0;
  h.inputs.loadBatch.mock.mockImplementation(() => ++reads >= 3 ? refreshed : h.approved);
  h.pinned.balance.mock.mockImplementation(async () => LOCAL_CEILING);
  await h.run();
  const caps = h.api.validateAuthorization(refreshed, NOW);
  assert.deepEqual(h.fees.mock.calls[0].arguments[2], caps);
  assert.deepEqual(h.state.prepared.caps, caps);
  assert.equal(JSON.stringify(h.approved), original); h.noIrreversible();
});

for (const [change, changeApproval, code] of changedApprovals) {
  test(`CURRENT 2K native balance: ${change} at fee-pricing authorization is not rescued by wallet funds`, async t => {
    const h = harness(t, { liquidatableNow: true }), changed = changeApproval(h.approved);
    let reads = 0;
    h.inputs.loadBatch.mock.mockImplementation(() => ++reads >= 3 ? changed : h.approved);
    await assert.rejects(h.run({ argv: budgetArgv(LOCAL_CEILING) }), { code });
    assert.equal(reads, 3); h.noTransaction();
  });
}

test("CURRENT 2K native balance: validate closure accepts exact liability and rejects one wei short without repricing", async t => {
  const h = harness(t, { liquidatableNow: true }), original = JSON.stringify(h.approved);
  await h.run({ argv: budgetArgv(750000000000000n) });
  const prepared = structuredClone(h.state.prepared), options = h.execution.mock.calls[0].arguments[0];
  const { gasLimit, maxFeePerGas } = prepared.transaction, liability = gasLimit * maxFeePerGas;
  const reads = h.inputs.loadBatch.mock.callCount(), checks = h.pinned.recheck.mock.callCount();
  h.pinned.balance.mock.mockImplementation(async () => liability);
  assert.deepEqual(await options.validate(), prepared.caps);
  h.pinned.balance.mock.mockImplementation(async () => liability - 1n);
  await assert.rejects(options.validate(), { code: "CURRENT_2K_NATIVE_BALANCE_INSUFFICIENT" });
  assert.equal(h.inputs.loadBatch.mock.callCount(), reads + 4);
  assert.equal(h.pinned.recheck.mock.callCount(), checks + 2);
  assert.equal(h.fees.mock.callCount(), 1); assert.equal(h.pinned.nonce.mock.callCount(), 1);
  assert.deepEqual(h.state.prepared, prepared); assert.equal(JSON.stringify(h.approved), original);
  h.noIrreversible(); // Callback checks only, not proof of the real guard/journal lifecycle.
});

test("CURRENT 2K native balance: missing pinned API fails closed before simulation or pricing", async t => {
  const h = harness(t, { liquidatableNow: true });
  delete h.pinned.balance;
  await assert.rejects(h.run(), error => error.code === "CURRENT_2K_NATIVE_BALANCE_UNAVAILABLE" && error.passSummary.armed === false);
  for (const spy of [h.pinned.call, h.pinned.estimateGas, h.pinned.nonce, h.fees, h.execution]) assert.equal(spy.mock.callCount(), 0);
  h.noIrreversible();
});

test("CURRENT 2K native balance: malformed values never become an unverified balance fallback", async t => {
  const h = harness(t, { liquidatableNow: true });
  for (const value of [undefined, null, {}, -1n, NaN, "unavailable", "-1", "", "0x"]) {
    h.pinned.balance.mock.mockImplementation(async () => value);
    await assert.rejects(h.run(), error => error.code === "CURRENT_2K_NATIVE_BALANCE_INVALID" && error.passSummary.armed === false);
  }
  for (const spy of [h.pinned.call, h.pinned.estimateGas, h.pinned.nonce, h.fees, h.execution]) assert.equal(spy.mock.callCount(), 0);
  h.noIrreversible();
});

test("CURRENT 2K native balance: provider/quorum errors retain the hold without fallback", async t => {
  const h = harness(t, { liquidatableNow: true });
  for (const code of ["PINNED_RPC_FAILED", "PROVIDER_RESULT_DISAGREEMENT", "PIN_EVIDENCE_INVALIDATED"]) {
    h.pinned.balance.mock.mockImplementation(async () => { throw new guard.ExecutionError(code); });
    await assert.rejects(h.run(), error => error.code === code && error.passSummary.armed === false);
  }
  assert.equal(h.fees.mock.callCount(), 0); assert.equal(h.execution.mock.callCount(), 0); h.noIrreversible();
});

for (const [label, balance, baseFee] of [["zero balance", 0n, "1"], ["unaffordable basefee", 750000000000000n, "1000000000000"]]) {
  test(`CURRENT 2K native balance: ${label} holds the exact plan, not authorization or a scaled alternative`, async t => {
    const h = harness(t, { liquidatableNow: true });
    h.pinned.pin.baseFeePerGas = baseFee;
    h.pinned.balance.mock.mockImplementation(async () => balance);
    const out = await h.run();
    assert.equal(out.fired, false); assert.equal(out.summary.armed, false);
    assert.equal(out.summary.reason, "NO_CANDIDATE_PASSED_PREFLIGHT");
    assert.deepEqual(out.summary.preflightFailures, [{ targetId: ID, reason: "FEE_CAP_BELOW_BASE_FEE" }]);
    assert.equal(h.fees.mock.callCount(), 1); assert.equal(h.pinned.call.mock.callCount(), 1);
    assert.equal(h.pinned.estimateGas.mock.callCount(), 1); assert.equal(h.pinned.balance.mock.callCount(), 1);
    assert.equal(h.pinned.nonce.mock.callCount(), 0); assert.equal(h.execution.mock.callCount(), 0);
    assert.equal(h.pinned.call.mock.calls[0].arguments[0].data, h.targets[ID].readyExecuteMorphoCalldata);
    h.noIrreversible();
  });
}

for (const boundary of ["pre-sign", "pre-send"]) {
  test(`CURRENT 2K native balance: simulated ${boundary} validate closure stops on shortfall without changing the prepared envelope`, async t => {
    const h = harness(t, { liquidatableNow: true });
    let binding;
    h.execution.mock.mockImplementation(async options => {
      h.state.prepares++; h.state.prepared = await options.prepare(); h.state.intent = options.intent;
      binding = structuredClone(h.state.prepared.transaction);
      await options.validate(); // Simulated initial guard validation, not an actual wallet/journal boundary.
      const short = binding.gasLimit * binding.maxFeePerGas - 1n;
      if (boundary === "pre-sign") h.pinned.balance.mock.mockImplementation(async () => short);
      await options.validate(); // Simulated pre-key validation; never invoke a signer.
      if (boundary === "pre-send") h.pinned.balance.mock.mockImplementation(async () => short);
      await options.validate(); // Simulated validation before the primary/secondary send wrapper.
      assert.fail("shortfall must prevent reaching send");
    });
    await assert.rejects(h.run({ argv: budgetArgv(750000000000000n) }), error =>
      error.code === "CURRENT_2K_NATIVE_BALANCE_INSUFFICIENT" && error.passSummary.armed === false);
    assert.deepEqual(h.state.prepared.transaction, binding);
    assert.equal(h.state.prepared.caps.spendCap, 750000000000000n);
    assert.equal(h.fees.mock.callCount(), 1); assert.equal(h.pinned.nonce.mock.callCount(), 1);
    assert.equal(h.inputs.loadBatch.mock.callCount(), boundary === "pre-sign" ? 10 : 12);
    assert.equal(h.pinned.recheck.mock.callCount(), boundary === "pre-sign" ? 4 : 5);
    assert.equal(h.pinned.balance.mock.callCount(), boundary === "pre-sign" ? 4 : 5);
    h.noIrreversible();
  });
}

test("default mode: even an eligible 2K route does not opt into the new balance policy", async t => {
  const h = harness(t, { liquidatableNow: true, scoped: false });
  for (const id of Object.keys(h.targets)) if (id !== ID) delete h.targets[id];
  h.pinned.balance.mock.mockImplementation(denied);
  const out = await h.run();
  assert.equal(out.fired, true); assert.equal(h.pinned.balance.mock.callCount(), 0);
  assert.deepEqual(h.fees.mock.calls[0].arguments[2], h.api.validateAuthorization(h.approved, NOW));
  h.noIrreversible();
});
