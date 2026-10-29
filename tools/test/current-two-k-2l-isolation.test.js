"use strict";

// Actual runPass/prepare/validate, with all custody, transport and artifact IO denied or trapped.
// Synthetic eligibility is not a production guard/journal, fork or live-readiness proof.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { compileFunction } = require("node:vm");
const { createRequire } = require("node:module");
const guard = require("../lib/wallet-execution-guard.js"), m1 = require("../lib/m1-live-evidence.js");
const rpc = require("../lib/executor-pinned-rpc.js"), watcher = require("../watch-top-whale-triggers.js");
const FILE = path.resolve(__dirname, "../execute-top-whale-trigger.js"), SOURCE = fs.readFileSync(FILE, "utf8"), native = createRequire(FILE);
const BUILD_FEES = guard.buildFees, W = 10n ** 18n, ZERO = "0x" + "00".repeat(20), NOW = Date.parse("2026-10-28T07:00:00Z");
const PIN = { chainId: 1, number: 1000, hash: "0x" + "11".repeat(32), timestamp: NOW / 1000 - 3, baseFeePerGas: "1" };
const FLAG = "--current-only-2k-2l", CAP = "--current-2k-2l-max-spend-wei", SCOPE = "CURRENT_2K_2L_ONLY";
const K = "target2K_AaveV3_WETH_WETH_0x7a05", L = "target2L_AaveV3_WETH_WETH_0xd185";
const DEFINITIONS = [
  [K, "#2K", "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3", 5400000000000000000n, W / 100n],
  [L, "#2L", "0xd185e7fafa5d75c7fcb3ff0844fe4c307d8fd57a", 12n * W, W / 10n],
];
const STATUS = path.resolve(__dirname, "../../reports/raw/fast/top-whale-executor-live-watch-2k-2l.json");
const LIVE = path.resolve(__dirname, "../../reports/raw/fast/top-whale-executor-live-watch.json");
const OBSERVATION = path.resolve(__dirname, "../../reports/raw/fast/top-whale-triggers-status.json");
const denied = () => assert.fail("offline two-target fixture forbids external/unrelated work");
const address = name => { const match = SOURCE.match(new RegExp(`\\b${name} = "(0x[0-9a-f]+)"`)); assert.ok(match, name); return match[1]; };
const budgetArgv = ceiling => [FLAG, CAP, ceiling.toString(), "--no-write"];
function loadRunner(nativeCollector) {
  const module = { exports: {} }, fixtureFs = new Proxy({}, { get: () => denied });
  const req = name => name === "node:fs" ? fixtureFs : name === "./watch-top-whale-triggers.js"
    ? { EXTRA_V3_WEETH_USERS: watcher.EXTRA_V3_WEETH_USERS, checkOnce: nativeCollector }
    : name === "./lib/m32-attended-call.cjs" ? denied() : native(name);
  compileFunction(SOURCE.replace(/^#![^\n]*\n/, ""), ["require", "module", "exports", "__dirname", "__filename", "fetch"], { filename: FILE })
    (req, module, module.exports, path.dirname(FILE), FILE, denied);
  return module.exports;
}
function row(api, definition, eligible, monitor = true) {
  const [id, rank, user, flash, floor] = definition;
  const params = { isAaveV3: true, target: address("POOL"), borrower: user, debtToken: address("WETH"), collateralToken: address("WETH"),
    collateralReserveId: 0, debtReserveId: 0, minCollateralSeized: 0, swapKind: 0, swapTarget: ZERO, swapSpender: ZERO,
    uniFee: 0, curveI: 0, curveJ: 0, minDebtTokenOut: 0, minProfitDebtToken: floor };
  return { id, rank, user, pool: address("POOL"), chainId: 1, executor: api.DEPLOYED_EXECUTOR, deployedExecutor: api.DEPLOYED_EXECUTOR,
    observationOnly: !monitor ? false : true, armed: false, liquidatableNow: eligible, executableNow: monitor ? false : eligible,
    ...(monitor ? { observationKind: "READ_ONLY_MONITOR", eligibleForPreflight: eligible } : {}),
    observationStatus: "COMPLETE", refreshStatus: "COMPLETE", observationBlock: PIN.number, observationHash: PIN.hash, observationTimestamp: PIN.timestamp,
    debtUsd: 30000, healthFactor: eligible ? 0.9999 : 1.0001,
    readyExecuteMorphoCalldata: api.UNIFIED_IFACE.encodeFunctionData("executeMorpho", [flash, params]) };
}
function batch(api) {
  return { schema: "live-execution-batch/v1", approved: true, approvedAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 60000).toISOString(), chainId: 1, chain: "ethereum",
    account: { address: guard.MAIN_ACCOUNT }, targets: api.REQUIRED_TARGETS.map(address => ({ address })),
    actions: ["liquidator.executeMorpho(uint256 flashAmount, UnifiedLiquidationParams params) when net > 0"],
    caps: { maxExecutionGasLimit: 1500000, maxExecutionSpendWei: "2000000000000000", signedExecutionsPerDay: 3,
      slippageFloor: "minDebtTokenOut >= quoted * 0.995; minProfitDebtToken > 0", principalAtRisk: "zero (atomic settlement)" } };
}
function harness(t, { eligible = [], monitor = true, nativeCollection = false } = {}) {
  const forbidden = [t.mock.method(guard, "acquireWalletLock", denied), t.mock.method(guard, "signWithProcessKey", denied),
    t.mock.method(m1, "strictContext", denied), t.mock.method(m1, "executeM1", denied), t.mock.method(globalThis, "fetch", denied),
    ...["createPinnedRpc", "loadRpcCandidates", "httpRpc"].map(key => t.mock.method(rpc, key, denied))];
  const writes = t.mock.method(guard, "atomicJson", () => {}), reconcile = t.mock.method(guard, "reconcileWallet", async () => {});
  let targets, pinned;
  const collector = t.mock.fn(async () => ({ pin: pinned.pin, targets }));
  const api = loadRunner(collector), approved = batch(api), state = { prepares: 0, prepared: null, intent: null, phase: "pricing", liability: null };
  targets = Object.fromEntries(DEFINITIONS.map(def => [def[0], row(api, def, eligible.includes(def[0]), monitor)]));
  const fees = t.mock.method(guard, "buildFees", (...args) => {
    const result = BUILD_FEES(...args); state.liability = result.gasLimit * result.maxFeePerGas; return result;
  });
  const execution = t.mock.method(guard, "executeGuarded", async options => {
    state.prepares++; state.phase = "prepare"; state.intent = options.intent;
    state.prepared = await options.prepare(); guard.validateTransaction(state.prepared.transaction, state.prepared.caps);
    for (const phase of ["pre-sign", "pre-send"]) {
      state.phase = phase; guard.validateTransaction(state.prepared.transaction, await options.validate());
    }
    return { stage: "PREPARED" }; // No actual guard, journal, signer or send.
  });
  pinned = { pin: { ...PIN }, evidence: {}, assertUsable: t.mock.fn(), recheck: t.mock.fn(async () => {}),
    call: t.mock.fn(async call => { assert.equal(call.to, api.DEPLOYED_EXECUTOR); return "0x"; }),
    estimateGas: t.mock.fn(async () => 445473n), nonce: t.mock.fn(async account => { assert.equal(account, guard.MAIN_ACCOUNT); return "0x7"; }),
    balance: t.mock.fn(async account => { assert.equal(account, guard.MAIN_ACCOUNT); return "0x" + W.toString(16); }),
    send: t.mock.fn(denied), receipt: t.mock.fn(denied) };
  const inputs = { execute: true, argv: [FLAG, "--no-write"], now: () => NOW, pinned,
    loadBatch: t.mock.fn(() => approved), loadMorphoBatch: t.mock.fn(denied), amendmentReadFile: t.mock.fn(denied), m1ReadFile: t.mock.fn(denied),
    signTransaction: t.mock.fn(denied), secondarySendRawTransaction: t.mock.fn(denied), ...(nativeCollection ? {} : { checkOnce: collector }) };
  const noIrreversible = () => {
    for (const spy of [...forbidden, inputs.loadMorphoBatch, inputs.amendmentReadFile, inputs.m1ReadFile,
      inputs.signTransaction, inputs.secondarySendRawTransaction, pinned.send, pinned.receipt]) assert.equal(spy.mock.callCount(), 0);
  };
  const noTransaction = () => {
    noIrreversible();
    for (const spy of [pinned.call, pinned.estimateGas, pinned.balance, pinned.nonce, fees, execution]) assert.equal(spy.mock.callCount(), 0);
    assert.equal(state.prepared, null); assert.equal(state.prepares, 0);
  };
  return { api, inputs, approved, targets, collector, pinned, writes, reconcile, fees, execution, state, noIrreversible, noTransaction,
    run: overrides => api.runPass({ ...inputs, ...overrides }) };
}
function scope(summary) { assert.equal(summary.collectionScope, SCOPE); assert.equal(summary.partition, SCOPE); }
function exactPrepared(h, id) {
  const [, , borrower, flash, floor] = DEFINITIONS.find(def => def[0] === id), prepared = h.state.prepared, tx = prepared.transaction;
  assert.equal(h.state.intent.targetId, id); assert.equal(h.state.intent.minProfitBeforeGasRaw, floor.toString());
  assert.equal(tx.data, h.targets[id].readyExecuteMorphoCalldata); assert.equal(tx.to, h.api.DEPLOYED_EXECUTOR);
  assert.equal(tx.chainId, 1); assert.equal(tx.nonce, 7); assert.equal(tx.value, 0n);
  const [actualFlash, p] = h.api.UNIFIED_IFACE.decodeFunctionData("executeMorpho", tx.data);
  assert.equal(actualFlash, flash); assert.equal(p.minProfitDebtToken, floor); assert.equal(p.borrower.toLowerCase(), borrower);
  assert.deepEqual([p.target, p.debtToken, p.collateralToken].map(value => value.toLowerCase()), [address("POOL"), address("WETH"), address("WETH")]);
  assert.equal(p.isAaveV3, true); assert.equal(p.swapTarget, ZERO); assert.equal(p.swapSpender, ZERO);
  assert.deepEqual([p.collateralReserveId, p.debtReserveId, p.minCollateralSeized, p.swapKind, p.uniFee, p.curveI, p.curveJ, p.minDebtTokenOut], Array(8).fill(0n));
  assert.equal(prepared.conservativeProfitBeforeGasWei, floor.toString()); assert.ok(floor > tx.gasLimit * tx.maxFeePerGas);
  h.noIrreversible();
}

test("two-target CURRENT: both healthy retain authorization reload, without transaction work", async t => {
  for (const monitor of [true, false]) {
    const h = harness(t, { monitor });
    for (const row of Object.values(h.targets)) row.nextBlockForecast = { eligibleForSimulation: true };
    const out = await h.run(); scope(out.summary);
    assert.equal(out.fired, false); assert.equal(out.summary.armed, true); assert.equal(out.summary.candidateCount, 0);
    assert.equal(out.summary.reason, undefined); assert.equal(out.summary.phaseTimingsMs.focusedM1Collection, null);
    assert.deepEqual(out.summary.targets.map(row => row.user), DEFINITIONS.map(def => def[2]));
    assert.ok(out.summary.targets.every(row => row.nextBlockForecast === undefined));
    assert.equal(h.inputs.loadBatch.mock.callCount(), 2); assert.equal(h.reconcile.mock.callCount(), 1);
    assert.equal(h.collector.mock.callCount(), 1); assert.equal(h.collector.mock.calls[0].arguments[0].m1Only, false);
    assert.equal(h.collector.mock.calls[0].arguments[0].nextBlockContext, null); h.noTransaction();
  }
});

test("two-target CURRENT: only 2L eligible prepares exact 12 WETH / 0.1 floor once", async t => {
  const h = harness(t, { eligible: [L] }), out = await h.run(); scope(out.summary);
  assert.equal(out.fired, true); assert.equal(out.summary.candidateCount, 1); assert.equal(out.summary.armed, false);
  assert.equal(h.state.prepares, 1); assert.equal(h.execution.mock.callCount(), 1); exactPrepared(h, L);
  const call = { from: guard.MAIN_ACCOUNT, to: h.api.DEPLOYED_EXECUTOR, data: h.targets[L].readyExecuteMorphoCalldata };
  assert.deepEqual(h.pinned.call.mock.calls.map(c => c.arguments), [[call]]);
  assert.deepEqual(h.pinned.estimateGas.mock.calls.map(c => c.arguments), [[call]]);
  assert.deepEqual(h.fees.mock.calls[0].arguments, [445473n, PIN.baseFeePerGas, h.api.validateAuthorization(h.approved, NOW), W / 10n]);
  assert.equal(h.fees.mock.callCount(), 1); assert.equal(h.pinned.nonce.mock.callCount(), 1);
});

test("two-target CURRENT: both eligible nominate two exact plans, preserving one guarded execution per pass", async t => {
  for (const rejectFirst of [false, true]) {
    const h = harness(t, { eligible: [K, L] });
    const candidates = h.api.selectCandidates({ pin: PIN, targets: h.targets });
    assert.deepEqual(candidates.map(c => [c.id, c.data]).sort(), DEFINITIONS.map(def => [def[0], h.targets[def[0]].readyExecuteMorphoCalldata]).sort());
    const [first, second] = candidates.map(candidate => candidate.id);
    if (rejectFirst) h.pinned.call.mock.mockImplementation(async call => {
      if (call.data === h.targets[first].readyExecuteMorphoCalldata) throw new guard.ExecutionError("CALL_REVERTED");
      assert.equal(call.data, h.targets[second].readyExecuteMorphoCalldata); return "0x";
    });
    const out = await h.run(); scope(out.summary); assert.equal(out.summary.candidateCount, 2);
    assert.equal(h.state.prepares, 1); exactPrepared(h, rejectFirst ? second : first);
    assert.deepEqual(h.pinned.call.mock.calls.map(c => c.arguments[0].data), (rejectFirst ? [first, second] : [first]).map(id => h.targets[id].readyExecuteMorphoCalldata));
    assert.equal(h.pinned.estimateGas.mock.callCount(), 1); assert.equal(h.fees.mock.callCount(), 1);
  }
});

test("two-target CURRENT: extra/missing/foreign rows and identity contradictions reject even healthy", async t => {
  const changes = [targets => { targets.foreign = { ...targets[K] }; }, targets => { delete targets[L]; },
    targets => { targets[L] = [targets[L]]; }, targets => { targets[L] = { ...targets[K] }; }];
  for (const id of [K, L]) for (const [field, value] of [["user", ZERO], ["pool", ZERO], ["borrower", ZERO], ["target", ZERO], ["marketId", ZERO],
    ["debtToken", ZERO], ["collateralToken", ZERO], ["chainId", 8453], ["chainId", undefined], ["executor", ZERO], ["deployedExecutor", ZERO],
    ["liquidatorAddress", ZERO], ["id", "foreign"], ["rank", "#2M"]]) changes.push(targets => { targets[id][field] = value; });
  for (const change of changes) {
    const h = harness(t); change(h.targets);
    await assert.rejects(h.run(), error => error.code === "CURRENT_2K_2L_EVIDENCE_REQUIRED" && error.passSummary.armed === false);
    assert.equal(h.reconcile.mock.callCount(), 0); h.noTransaction();
  }
});

test("two-target CURRENT: every fixed tuple field, principal, floor both directions and suffix are bound in healthy/eligible rows", async t => {
  for (const id of [K, L]) for (const eligible of [[], [id]]) {
    const h = harness(t, { eligible }), original = h.targets[id].readyExecuteMorphoCalldata;
    const [flash, decoded] = h.api.UNIFIED_IFACE.decodeFunctionData("executeMorpho", original), p = decoded.toObject();
    const mutations = Object.entries(p).map(([key, value]) => [flash, { ...p, [key]: typeof value === "boolean" ? !value : typeof value === "string" ? (value === ZERO ? address("POOL") : ZERO) : value + 1n }]);
    mutations.push([flash, { ...p, minProfitDebtToken: p.minProfitDebtToken - 1n }], [flash + 1n, p], [flash - 1n, p], [flash / 2n, p], [flash / 4n, p]);
    const data = [...mutations.map(args => h.api.UNIFIED_IFACE.encodeFunctionData("executeMorpho", args)), original + "00", original.slice(0, -2), "0x", undefined];
    for (const bad of data) {
      h.targets[id].readyExecuteMorphoCalldata = bad;
      await assert.rejects(h.run(), error => error.code === "CURRENT_2K_2L_CALLDATA_INVALID" && error.passSummary.armed === false);
    }
    assert.equal(h.reconcile.mock.callCount(), 0); h.noTransaction();
  }
});

test("two-target CURRENT: stale/failed provenance, unknown health and invalidated pins cannot become healthy waiting", async t => {
  for (const id of [K, L]) for (const patch of [{ retained: true }, { observationStatus: "INCOMPLETE" }, { refreshStatus: "INCOMPLETE" },
    { observationBlock: PIN.number - 1 }, { observationHash: undefined }, { observationTimestamp: PIN.timestamp - 1 }, { observationKind: undefined },
    { eligibleForPreflight: true }, { executableNow: true }, { inactive: true }, { positionStatus: "UNKNOWN" }, { debtReadStatus: "UNAVAILABLE" },
    { debtRaw: "0" }, { debtUsd: 0 }, { healthFactor: NaN }, { healthFactor: 0.9 }, { liquidatableNow: undefined }]) {
    const h = harness(t); Object.assign(h.targets[id], patch);
    await assert.rejects(h.run(), { code: "CURRENT_2K_2L_EVIDENCE_REQUIRED" }); h.noTransaction();
  }
  for (const code of ["BROAD_COLLECTION_PARTIAL", "COLLECTOR_PIN_MISMATCH", "PIN_EVIDENCE_INVALIDATED"]) {
    const h = harness(t);
    if (code === "PIN_EVIDENCE_INVALIDATED") h.pinned.recheck.mock.mockImplementation(async () => { throw new guard.ExecutionError(code); });
    else h.collector.mock.mockImplementation(async () => ({ targets: h.targets, partial: code === "BROAD_COLLECTION_PARTIAL",
      pin: code === "COLLECTOR_PIN_MISMATCH" ? { ...PIN, number: PIN.number + 1 } : PIN }));
    await assert.rejects(h.run(), error => error.code === code && error.passSummary.armed === false); h.noTransaction();
  }
});

test("two-target CURRENT: conflicts and malformed/unscoped budgets reject in parser, main and direct pass before dependencies", async t => {
  const h = harness(t), conflict = "CURRENT_2K_2L_MODE_CONFLICT", invalid = "CURRENT_2K_2L_MAX_SPEND_INVALID";
  const cases = [
    ...[FLAG, "--current-only-2k", "--current-2k-max-spend-wei", "--current-2k-max-spend-wei=1", "--m1-only", "--next-block", "--measure-only",
      "--reuse-qualified-pair", "--m1-hot-path-v2", "--m1-ws-heads", "--m1-capability-v1", "--m32-only", "--m32-warm-watch"].map(flag => [[FLAG, flag], conflict]),
    [[FLAG + "=true"], conflict], [[CAP, "1"], invalid], [["--current-only-2k", CAP, "1"], invalid], [["--m32-only", CAP, "1"], invalid],
    [[FLAG, CAP], invalid], [[FLAG, CAP, "1", CAP, "2"], invalid], [[FLAG, CAP + "=1"], invalid],
    ...["", "0", "-1", "+1", "1.5", "1e3", "0x1", "01", " 1", "1 ", "NaN", "Infinity", 1, 1n, true, null, {}, ["1"], (1n << 256n).toString()]
      .map(value => [[FLAG, CAP, value], invalid]),
  ];
  for (const [argv, code] of cases) {
    assert.throws(() => h.api.parseRunnerMode(argv), { code });
    await assert.rejects(h.api.main(argv, new Proxy({}, { get: denied })), { code });
    await assert.rejects(h.run({ argv, pinned: new Proxy({}, { get: denied }) }), { code });
  }
  for (const option of ["allowFutureContinuation", "futureContinuationOwner", "hotPathLease", "hotPathTimings", "m1Budget"])
    await assert.rejects(h.run({ [option]: option === "allowFutureContinuation" ? true : {}, pinned: new Proxy({}, { get: denied }) }), { code: conflict });
  assert.equal(h.api.parseRunnerMode([FLAG, CAP, ((1n << 256n) - 1n).toString()]).execute, false);
  assert.equal(h.api.parseRunnerMode([FLAG, "--execute"]).execute, true);
  assert.throws(() => h.api.parseRunnerMode([FLAG, "--execute-if-liquidatable"]), { code: "UNSUPPORTED_EXECUTION_FLAG" });
  assert.equal(h.inputs.loadBatch.mock.callCount(), 0); assert.equal(h.collector.mock.callCount(), 0); h.noTransaction();
});

test("two-target CURRENT: either target prices min(approval, local cap, balance) but returns authorization caps unchanged", async t => {
  for (const id of [K, L]) for (const [approval, ceiling, balance, priced] of [
    [2000000000000000n, null, W, 2000000000000000n], [500000000000000n, null, 854826828899120n, 500000000000000n],
    [2000000000000000n, 750000000000000n, 854826828899120n, 750000000000000n],
    [2000000000000000n, 750000000000000n, 700000000000000n, 700000000000000n],
  ]) {
    const h = harness(t, { eligible: [id] }); h.approved.caps.maxExecutionSpendWei = approval.toString();
    const original = JSON.stringify(h.approved); Object.freeze(h.approved.caps); Object.freeze(h.approved);
    h.pinned.balance.mock.mockImplementation(async account => { assert.equal(account, guard.MAIN_ACCOUNT); return balance; });
    await h.run(ceiling === null ? {} : { argv: budgetArgv(ceiling) }); exactPrepared(h, id);
    const caps = h.api.validateAuthorization(h.approved, NOW), authority = ceiling === null ? caps : { ...caps, spendCap: ceiling };
    assert.deepEqual(h.state.prepared.caps, authority); assert.deepEqual(h.fees.mock.calls[0].arguments[2], { ...authority, spendCap: priced });
    assert.ok(h.state.liability <= priced); assert.equal(h.fees.mock.callCount(), 1); assert.equal(JSON.stringify(h.approved), original);
  }
});

test("two-target CURRENT: exact liability passes and one-wei shortfall stops at prepare/pre-sign/pre-send without repricing", async t => {
  for (const id of [K, L]) for (const phase of ["prepare", "pre-sign", "pre-send"]) for (const short of [false, true]) {
    const h = harness(t, { eligible: [id] });
    h.pinned.balance.mock.mockImplementation(async () => h.state.phase === "pricing" ? W : h.state.liability - (short && h.state.phase === phase ? 1n : 0n));
    if (short) await assert.rejects(h.run({ argv: budgetArgv(750000000000000n) }), error =>
      error.code === "CURRENT_2K_2L_NATIVE_BALANCE_INSUFFICIENT" && error.passSummary.armed === false);
    else { await h.run({ argv: budgetArgv(750000000000000n) }); exactPrepared(h, id); }
    assert.equal(h.fees.mock.callCount(), 1); assert.equal(h.pinned.call.mock.callCount(), 1); assert.equal(h.pinned.estimateGas.mock.callCount(), 1);
    assert.equal(h.pinned.nonce.mock.callCount(), short && phase === "prepare" ? 0 : 1);
    assert.equal(h.state.prepares, 1); if (h.state.prepared) exactPrepared(h, id); h.noIrreversible();
  }
});

test("two-target CURRENT: missing/malformed balance and provider errors have no fallback", async t => {
  const invalid = [undefined, null, {}, -1n, NaN, "unavailable", "-1", "", "0x", (1n << 256n)];
  for (const value of ["missing-api", ...invalid, "PINNED_RPC_FAILED", "PROVIDER_RESULT_DISAGREEMENT", "PIN_EVIDENCE_INVALIDATED"]) {
    const h = harness(t, { eligible: [L] });
    let code = "CURRENT_2K_2L_NATIVE_BALANCE_INVALID";
    if (value === "missing-api") { delete h.pinned.balance; code = "CURRENT_2K_2L_NATIVE_BALANCE_UNAVAILABLE"; }
    else if (typeof value === "string" && /^[A-Z_]+$/.test(value)) {
      code = value; h.pinned.balance.mock.mockImplementation(async () => { throw new guard.ExecutionError(code); });
    } else h.pinned.balance.mock.mockImplementation(async () => value);
    await assert.rejects(h.run(), error => error.code === code && error.passSummary.armed === false);
    for (const spy of [h.pinned.call, h.pinned.estimateGas, h.pinned.nonce, h.fees, h.execution]) assert.equal(spy.mock.callCount(), 0);
    h.noIrreversible();
  }
});

test("two-target CURRENT: approval expiry/revocation/tightening is reloaded at every existing boundary", async t => {
  for (const read of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) for (const change of ["expired", "revoked", "tightened"]) {
    const h = harness(t, { eligible: read === 2 ? [] : [L] }), original = JSON.stringify(h.approved);
    const changed = change === "expired" ? { ...h.approved, expiresAt: new Date(NOW).toISOString() }
      : change === "revoked" ? { ...h.approved, revoked: true }
      : { ...h.approved, caps: { ...h.approved.caps, maxExecutionSpendWei: "749999999999999" } };
    let reads = 0; h.inputs.loadBatch.mock.mockImplementation(() => ++reads >= read ? changed : h.approved);
    const code = change === "tightened" ? "CURRENT_2K_2L_MAX_SPEND_EXCEEDS_AUTHORIZATION" : "BATCH_INVALID_OR_EXPIRED";
    await assert.rejects(h.run({ argv: budgetArgv(750000000000000n) }), error => error.code === code && error.passSummary.armed === false);
    assert.equal(reads, read); assert.equal(JSON.stringify(h.approved), original); h.noIrreversible();
    if (read <= 3) h.noTransaction();
  }
  // No local cap: refreshed authority prices the plan, then a later tightening
  // must reject the already fixed liability rather than silently rebuilding fees.
  const h = harness(t, { eligible: [L] }), refreshed = { ...h.approved, caps: { ...h.approved.caps, maxExecutionSpendWei: "500000000000000" } };
  let reads = 0; h.inputs.loadBatch.mock.mockImplementation(() => ++reads >= 3 ? refreshed : h.approved);
  await h.run(); assert.deepEqual(h.fees.mock.calls[0].arguments[2], h.api.validateAuthorization(refreshed, NOW));
  const binding = structuredClone(h.state.prepared), options = h.execution.mock.calls[0].arguments[0];
  refreshed.caps.maxExecutionSpendWei = (h.state.liability - 1n).toString();
  await assert.rejects(options.validate(), { code: "TX_CAP_EXCEEDED" });
  assert.deepEqual(h.state.prepared, binding); assert.equal(h.fees.mock.callCount(), 1); h.noIrreversible();
});

test("two-target CURRENT: unaffordable/reverting fixed plans never attempt 50/25 percent variants or relax floors", async t => {
  for (const id of [K, L]) for (const failure of ["zero-balance", "basefee", "call", "estimate", "floor"]) {
    const h = harness(t, { eligible: [id] });
    if (failure === "zero-balance") h.pinned.balance.mock.mockImplementation(async () => 0n);
    if (failure === "basefee") h.pinned.pin.baseFeePerGas = "1000000000000";
    if (failure === "call") h.pinned.call.mock.mockImplementation(async () => { throw new guard.ExecutionError("CALL_REVERTED"); });
    if (failure === "estimate") h.pinned.estimateGas.mock.mockImplementation(async () => { throw new guard.ExecutionError("ESTIMATE_FAILED"); });
    if (failure === "floor") h.fees.mock.mockImplementation(() => ({ gasLimit: W, maxFeePerGas: W, maxPriorityFeePerGas: 1n }));
    const out = await h.run(), reason = { "zero-balance": "FEE_CAP_BELOW_BASE_FEE", basefee: "FEE_CAP_BELOW_BASE_FEE", call: "CALL_REVERTED", estimate: "ESTIMATE_FAILED", floor: "PROFIT_FLOOR_BELOW_GAS_BUDGET" }[failure];
    assert.equal(out.fired, false); assert.equal(out.summary.armed, false); assert.equal(out.summary.reason, "NO_CANDIDATE_PASSED_PREFLIGHT");
    assert.deepEqual(out.summary.preflightFailures, [{ targetId: id, reason }]);
    assert.deepEqual(h.pinned.call.mock.calls.map(c => c.arguments[0].data), [h.targets[id].readyExecuteMorphoCalldata]);
    assert.equal(h.pinned.estimateGas.mock.callCount(), failure === "call" ? 0 : 1);
    assert.equal(h.execution.mock.callCount(), 0); assert.equal(h.pinned.nonce.mock.callCount(), 0); h.noIrreversible();
  }
});

test("two-target CURRENT: direct success/healthy/failure status is separate, protected paths reject, no-write remains honored", async t => {
  for (const kind of ["healthy", "prepared", "failed", "no-write"]) {
    const h = harness(t, { eligible: kind === "prepared" ? [L] : [] });
    if (kind === "failed") delete h.targets[L];
    const options = { argv: kind === "no-write" ? [FLAG, "--no-write"] : [FLAG], writeOut: true };
    if (kind === "failed") await assert.rejects(h.run(options), { code: "CURRENT_2K_2L_EVIDENCE_REQUIRED" }); else await h.run(options);
    assert.equal(h.writes.mock.callCount(), kind === "no-write" ? 0 : 1);
    for (const call of h.writes.mock.calls) { assert.equal(call.arguments[0], STATUS); scope(call.arguments[1]); }
    h.noIrreversible();
  }
  const h = harness(t);
  for (const statusFile of [LIVE, OBSERVATION, LIVE.toUpperCase()])
    await assert.rejects(h.run({ statusFile, pinned: new Proxy({}, { get: denied }) }), { code: "CURRENT_2K_2L_STATUS_PATH_CONFLICT" });
  assert.equal(h.inputs.loadBatch.mock.callCount(), 0); assert.equal(h.writes.mock.callCount(), 0); h.noTransaction();
});

test("two-target CURRENT: authorization expiring during the balance await is caught before caps are returned", async t => {
  const h = harness(t, { eligible: [K] }), baseline = h.approved.expiresAt;
  let mutated = false;
  h.pinned.balance.mock.mockImplementation(async account => {
    assert.equal(account, guard.MAIN_ACCOUNT);
    if (h.state.phase === "pre-sign" && !mutated) {
      mutated = true;
      h.approved.expiresAt = new Date(NOW).toISOString(); // expires exactly now, mid-await
    }
    return "0x" + W.toString(16);
  });
  await assert.rejects(() => h.run(), error => error.code === "BATCH_INVALID_OR_EXPIRED");
  assert.equal(mutated, true, "the authorization change must happen during a validate-phase balance read");
  assert.notEqual(h.approved.expiresAt, baseline);
  assert.equal(h.state.prepares, 1); // prepare ran; rejection happened at the guard validation boundary
});

test("two-target CURRENT: main resolves the separate path before acquisition and on failures, without touching live artifacts", async t => {
  t.mock.method(Date, "now", () => NOW);
  for (const kind of ["healthy", "prepared", "acquisition", "authorization", "no-write"]) {
    const h = harness(t, { eligible: kind === "prepared" ? [L] : [] }), output = t.mock.fn(), loadCandidates = t.mock.fn(() => []);
    const connect = t.mock.fn(async () => { if (kind === "acquisition") throw new guard.ExecutionError("PINNED_RPC_FAILED"); return h.pinned; });
    const pass = t.mock.fn(async options => {
      assert.equal(options.statusFile, STATUS);
      return h.api.runPass({ ...h.inputs, ...options, now: () => NOW, checkOnce: h.collector,
        signTransaction: h.inputs.signTransaction, secondarySendRawTransaction: h.inputs.secondarySendRawTransaction });
    });
    const argv = [FLAG, "--execute", "--watch", "5", "--max-runs", "1", ...(kind === "authorization" ? [CAP, "2000000000000001"] : []), ...(kind === "no-write" ? ["--no-write"] : [])];
    await h.api.main(argv, { loadBatch: h.inputs.loadBatch, loadMorphoBatch: denied, loadCandidates, connect, runPass: pass, output });
    assert.equal(output.mock.callCount(), 1); scope(output.mock.calls[0].arguments[0]);
    assert.equal(h.writes.mock.callCount(), kind === "no-write" ? 0 : 1);
    assert.ok(h.writes.mock.calls.every(call => call.arguments[0] === STATUS));
    if (kind === "authorization") { assert.equal(loadCandidates.mock.callCount(), 0); assert.equal(connect.mock.callCount(), 0);
      assert.equal(output.mock.calls[0].arguments[0].reason, "CURRENT_2K_2L_MAX_SPEND_EXCEEDS_AUTHORIZATION"); }
    if (kind === "prepared") exactPrepared(h, L); else h.noTransaction();
  }
});

test("two-target CURRENT: only the native broad adapter is projected; its two selected rows still require exact admission", async t => {
  for (const mutate of [false, true]) {
    const h = harness(t, { nativeCollection: true });
    h.targets.foreign = { ...h.targets[K], liquidatableNow: true };
    h.targets.targetM1_Morpho_USDe_DAI = { user: address("M1_BORROWER"), liquidatableNow: true };
    if (mutate) h.targets[L].readyExecuteMorphoCalldata += "00";
    if (mutate) await assert.rejects(h.run(), { code: "CURRENT_2K_2L_CALLDATA_INVALID" });
    else { const out = await h.run(); scope(out.summary); assert.equal(out.summary.candidateCount, 0); assert.equal(out.summary.targets.length, 2); }
    assert.equal(h.collector.mock.callCount(), 1); assert.equal(h.collector.mock.calls[0].arguments[0].includeV3Whales, true); h.noTransaction();
  }
});
