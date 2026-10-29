"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { Interface } = require("../node_modules/ethers");
const watcher = require("../watch-top-whale-triggers.js"), runner = require("../execute-top-whale-trigger.js");
const m1 = require("../lib/m1-live-evidence.js"), guard = require("../lib/wallet-execution-guard.js");
const { morphoProjection, morphoSeizeFits } = require("../lib/passive-accrual-forecast.js");
const { createNextBlockContext } = require("../lib/next-block-simulation.js");
const { fixture, W, PIN, NOW, hex, calldata } = require("./m1-live-evidence.test.js");
const { mockSignedTransactionBinding } = require("./signed-transaction-binding-fixture.js");
const RATE = new Interface(["function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns(uint256)"]);

function focusedFixture(options = {}) {
  const pin = { ...PIN, chainId: 1 }, calls = [], market = [2000000n * W, 2000000n * W * 1000000n,
    1000000n * W - 1n, 1000000n * W * 1000000n - 1000000n, BigInt(pin.timestamp), 0n];
  const position = options.position || [0n, (86000n * W - W / 100n) * 1000000n, 100000n * W], rate = options.rate ?? 100000000000n;
  const transport = async (_rpc, method, params) => {
    assert.equal(method, "eth_call", "focused path must not request latest, nonce, code, or unrelated state");
    assert.equal(params[1], pin.hash); assert.equal(params[0].to.toLowerCase(), "0xca11bde05977b3631167028862be2a173976ca11");
    const rows = m1.MULTI_IFACE.decodeFunctionData("aggregate3", params[0].data)[0]; calls.push(rows);
    return m1.MULTI_IFACE.encodeFunctionResult("aggregate3", [rows.map((row, i) => {
      if (rows.length === 1) {
        assert.equal(row.target.toLowerCase(), m1.MP.irm);
        const args = RATE.decodeFunctionData("borrowRateView", row.callData); assert.deepEqual([...args[1]], market);
        return { success: !options.missingRate, returnData: options.missingRate ? "0x" : RATE.encodeFunctionResult("borrowRateView", [rate]) };
      }
      assert.equal(rows.length, 3);
      const name = ["market", "position", "price"][i];
      assert.equal(row.target.toLowerCase(), i < 2 ? m1.MORPHO : m1.MP.oracle);
      const args = m1.STATE_IFACE.decodeFunctionData(name, row.callData);
      if (i < 2) assert.equal(args[0], m1.MARKET);
      if (i === 1) assert.equal(args[1].toLowerCase(), m1.BORROWER);
      return { success: true, returnData: m1.STATE_IFACE.encodeFunctionResult(name, [market, position, [10n ** 36n]][i]) };
    })]);
  };
  const collectorOptions = { pin, now: () => NOW, m1Only: true, writeOut: true, nextBlockContext: createNextBlockContext(pin),
    resolveRpc: async chain => { assert.equal(chain, 1); return "offline"; }, rpcCall: transport };
  return { pin, calls, market, position, rate, collectorOptions, collect: overrides => watcher.checkOnce({ ...collectorOptions, ...overrides }) };
}

test("production focused watcher -> tagged nomination -> selector -> live share clamp, never template RPC/signing", async t => {
  const c = focusedFixture(), status = await c.collect(), row = status.targets[m1.ID], n = row.m1Nomination;
  assert.equal(status.partial, true); assert.equal(status.collectionScope, "M1_ONLY"); assert.deepEqual(c.calls.map(x => x.length), [3, 1]);
  assert.equal(row.liquidatableNow, false); assert.equal(row.executableNow, false); assert.notEqual(row.routePositive, true);
  assert.equal(row.readyExecuteMorphoBlueCalldata, null); assert.equal(n.ceilingRaw, (100000n * W).toString());
  assert.equal(m1.EXEC_IFACE.decodeFunctionData("execute", n.calldataTemplate)[5], 0n);
  const projection = morphoProjection({ market: c.market, position: c.position, price: 10n ** 36n, lltv: m1.MP.lltv, rate: c.rate, context: row.nextBlockForecast.context });
  assert.equal(morphoSeizeFits(projection, { market: c.market, position: c.position, price: 10n ** 36n, seizedAssets: 100000n * W, lif: 1043841336116910229n }), false);
  const candidates = runner.selectCandidates(status, ["--next-block"], { nextBlockContext: row.nextBlockForecast.context });
  assert.equal(candidates.length, 1); assert.equal(candidates[0].executionMode, "NEXT_BLOCK_PASSIVE");
  assert.equal(m1.candidateBinding(candidates[0]).maximum, n.ceilingRaw);
  const f = fixture(t, { collateral: c.position[2], borrowShares: c.position[1] }), order = [];
  const out = await f.run({ checkOnce: async opts => { order.push(opts.m1Only ? "focused" : "broad"); return status; } });
  assert.equal(out.fired, true, JSON.stringify(out.summary)); assert.deepEqual(order, ["focused"]);
  const selected = BigInt(out.summary.execution.intent.m1LiveProof.selectedSeizedRaw);
  assert.ok(selected > 89770n * W && selected < 89771n * W);
  assert.equal(out.summary.partial, true); assert.ok(out.summary.targets.length);
  for (const tx of [...f.state.calls, ...f.state.simulations].filter(tx => tx.to === m1.EXECUTOR)) {
    assert.notEqual(tx.data || tx.input, n.calldataTemplate); assert.ok(m1.EXEC_IFACE.decodeFunctionData("execute", tx.data || tx.input)[5] > 0n);
  }
  assert.notEqual(f.state.tx.data, n.calldataTemplate);
  assert.equal(out.summary.phaseTimingsMs.broadCollection, null);
  for (const value of Object.values(out.summary.phaseTimingsMs.preparation)) assert.equal(typeof value, "number");
});

test("focused nomination holds missing health, preserves exact unhealthy/near predicates and explicit null context", async () => {
  const missing = await focusedFixture({ missingRate: true }).collect();
  assert.equal(missing.targets[m1.ID].m1Nomination, undefined); assert.equal(missing.targets[m1.ID].debtReadStatus, "UNAVAILABLE");
  assert.deepEqual(runner.selectCandidates(missing), []);
  const unhealthy = focusedFixture({ position: [0n, (86000n * W + 1n) * 1000000n, 100000n * W], rate: 0n });
  const status = await unhealthy.collect({ nextBlockContext: null });
  assert.equal(status.targets[m1.ID].liquidatableNow, true); assert.equal(runner.selectCandidates(status).length, 1);
  assert.equal(status.targets[m1.ID].nextBlockForecast, undefined);
  for (const debt of [0n, 85000n * W, 86000n * W - W / 2n]) {
    const c = focusedFixture({ position: [0n, debt * 1000000n, 100000n * W] }), s = await c.collect();
    assert.equal(s.targets[m1.ID].nextBlockForecast, undefined);
    assert.deepEqual(runner.selectCandidates(s, [], { nextBlockContext: c.collectorOptions.nextBlockContext }), []);
  }
});

test("zero minOut is valid only for an exact identity/pin-bound M1 proposal; transplant rejected", async () => {
  const c = focusedFixture({ position: [0n, 87000n * W * 1000000n, 100000n * W] }), status = await c.collect();
  const original = status.targets[m1.ID];
  for (const edit of [row => { delete row.m1Nomination; row.readyExecuteMorphoBlueCalldata = original.m1Nomination.calldataTemplate; },
    row => row.m1Nomination.kind = "EXECUTABLE", row => row.m1Nomination.pin.number++, row => row.m1Nomination.pin.timestamp++,
    row => row.m1Nomination.observedCollateralRaw = "1", row => row.m1Nomination.marketId = "0x" + "00".repeat(32),
    row => row.m1Nomination.ceilingRaw = (108501n * W).toString()]) {
    const row = structuredClone(original); edit(row);
    assert.throws(() => runner.selectCandidates({ ...status, targets: { [m1.ID]: row } }), /INVALID/);
  }
  const candidate = runner.selectCandidates(status)[0];
  assert.throws(() => m1.candidateBinding(candidate, { ...c.pin, number: c.pin.number + 1 }), /M1_SCOPE_MISMATCH/);
  const wst = { user: "0xb224f589297a5a207e6069de5dafd4b120129817", liquidatableNow: true, readyExecuteMorphoBlueCalldata: calldata({ minimum: 0n }) };
  assert.throws(() => runner.selectCandidates({ targets: { morpho_wstETH_WETH_Whales: [wst] } }), /MISMATCH|INVALID/);
});

test("CURRENT capped probe admits 2gwei/500k -> padded 600k under unchanged spend; genuinely unaffordable holds", async t => {
  const f = fixture(t, { future: false, pin: { baseFeePerGas: "2000000000" }, gasEstimate: 500000 });
  const receipt = f.pinned.receipt; f.pinned.receipt = async (...args) => ({ ...await receipt(...args), gasUsed: hex(500000) });
  const out = await f.run(); assert.equal(out.fired, true, JSON.stringify(out.summary));
  assert.equal(f.state.tx.gasLimit, 600000n); assert.equal(f.state.tx.maxFeePerGas, 3333333333n);
  assert.ok(f.state.tx.gasLimit * f.state.tx.maxFeePerGas <= 2000000000000000n);
  const caps = { gasCap: 1500000n, spendCap: 2000000000000000n, feeCap: null };
  assert.deepEqual(m1.envelope(f.pinned.pin, caps, 7, false), { type: 2, chainId: 1, from: guard.MAIN_ACCOUNT, nonce: 7, value: 0n,
    gasLimit: 1000000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 0n, accessList: [] });
  assert.throws(() => m1.envelope(f.pinned.pin, caps, 7, true), /FEE_CAP_BELOW_BASE_FEE/);
  assert.throws(() => m1.envelope(f.pinned.pin, { ...caps, feeCap: 1n }, 7, false), /FEE_CAP_BELOW_BASE_FEE/);
  assert.equal(m1.envelope({ baseFeePerGas: 0n }, caps, 7, false).maxFeePerGas, 1n);
  for (const gasEstimate of [1100000, 2000000]) {
    const held = fixture(t, { future: false, pin: { baseFeePerGas: "2000000000" }, gasEstimate }), result = await held.run();
    assert.equal(result.fired, false); assert.equal(held.state.signs, 0); assert.equal(held.state.sends, 0);
  }
});

test("full-size quote revert or nonpositive quote economics cannot suppress independently requoted half/quarter", async t => {
  for (const future of [false, true]) for (const outcome of ["negative", "revert", "zero"]) {
    const f = fixture(t, { future, quote: input => {
      if (input === 108500n * W) { if (outcome === "revert") throw new guard.ExecutionError(future ? "NEXT_BLOCK_REVERTED" : "CALL_REVERTED"); return outcome === "zero" ? 0n : 100000n * W; }
      return 108000n * W * input / (108500n * W);
    } });
    const out = await f.run(); assert.equal(out.fired, true, JSON.stringify(out.summary));
    assert.equal(m1.EXEC_IFACE.decodeFunctionData("execute", f.state.tx.data)[2], 54250n * W);
    const proof = out.summary.execution.intent.m1LiveProof;
    assert.equal(proof.evaluatedVariants.length, 3); assert.equal(proof.evaluatedVariants[0].status, { revert: "QUOTE_REVERTED", zero: "QUOTE_ZERO", negative: "NET_NONPOSITIVE" }[outcome]);
    if (future) assert.equal(f.state.tx.gasLimit, 1500000n);
  }
});

test("unsigned M1 hold continues broad once, no same-pin retry, keeps summary/polling and publishes only full collection", async t => {
  const f = fixture(t, { future: false, dustToken: m1.DAI }), order = [], file = path.join(f.root, "observation.json"), statusFile = path.join(f.root, "status.json");
  fs.writeFileSync(file, '{"sentinel":"retained"}');
  const row = { ...f.row, rank: "#M1", bpsToLiquidation: 0.01, positionStatus: "OPEN", debtRaw: "1" };
  const out = await f.run({ writeOut: true, observationFile: file, statusFile, checkOnce: async options => {
    order.push(options.m1Only ? "focused" : "broad"); assert.equal(options.writeOut, false);
    assert.equal(fs.readFileSync(file, "utf8"), '{"sentinel":"retained"}');
    if (!options.m1Only) assert.equal(f.state.codes, 1, "M1 preflight happened before broad");
    return { partial: options.m1Only === true, pin: { ...PIN, chainId: 1 }, targets: { [m1.ID]: row } };
  } });
  assert.deepEqual(order, ["focused", "broad"]); assert.equal(f.state.codes, 1); assert.equal(out.fired, false);
  assert.equal(out.summary.partial, false); assert.equal(out.summary.preflightFailures[0].reason, "M1_EXECUTOR_INVENTORY_NONZERO");
  assert.equal(runner.computeEthPollIntervalMs(out.summary, 20000), 6000); assert.equal(runner.computeEthPollIntervalMs(out.summary, 5000), 5000);
  assert.equal(JSON.parse(fs.readFileSync(file)).partial, false); assert.equal(JSON.parse(fs.readFileSync(statusFile)).targets.length, 1);
});

test("signed success, signer failure and uncertain send end pass without broad collection or observation overwrite", async t => {
  for (const outcome of ["success", "signer", "send"]) {
    const f = fixture(t, { future: false }), file = path.join(f.root, "observation.json"), statusFile = path.join(f.root, "status.json");
    fs.writeFileSync(file, "UNCHANGED"); let collects = 0;
    if (outcome === "send") f.pinned.send = async () => { throw new guard.ExecutionError("OFFLINE_SEND_FAILURE"); };
    const out = await f.run({ writeOut: true, observationFile: file, statusFile,
      ...(outcome === "signer" ? { signTransaction: async () => { throw new guard.ExecutionError("OFFLINE_SIGNER_FAILURE"); } } : {}),
      checkOnce: async opts => { collects++; assert.equal(opts.m1Only, true); return { pin: { ...PIN, chainId: 1 }, targets: { [m1.ID]: f.row } }; } });
    assert.equal(collects, 1); assert.equal(fs.readFileSync(file, "utf8"), "UNCHANGED"); assert.equal(out.summary.partial, true);
    assert.equal(out.fired, outcome === "success");
    if (outcome !== "success") { assert.equal(out.summary.armed, false); assert.equal(out.summary.reason, "SIGNED_ATTEMPT_ENDED_PASS"); }
  }
});

test("poisoned base ends pass; expired child disables future but broad CURRENT still runs without M1 retry", async t => {
  const poisoned = fixture(t, { future: false, afterNonce: (_state, pinned) => {
    pinned.assertUsable = () => { throw new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED"); };
  } });
  let calls = 0;
  await assert.rejects(poisoned.run({ checkOnce: async opts => { calls++; assert.equal(opts.m1Only, true);
    return { pin: { ...PIN, chainId: 1 }, targets: { [m1.ID]: poisoned.row } }; } }), error => {
    assert.equal(error.passSummary.targets.length, 1); return error.code === "PIN_EVIDENCE_INVALIDATED";
  });
  assert.equal(calls, 1); assert.equal(poisoned.state.signs, 0);
  const f = fixture(t, { afterNonce: (state, pinned) => state.now = pinned.nextBlock.context.timestamp * 1000 }); let broad = 0;
  const out = await f.run({ checkOnce: async opts => {
    if (!opts.m1Only) { broad++; assert.equal(opts.nextBlockContext, null); }
    return { pin: { ...PIN, chainId: 1 }, targets: { [m1.ID]: opts.m1Only ? f.row : { ...f.row, liquidatableNow: true, readyExecuteMorphoBlueCalldata: calldata() } } };
  } });
  assert.equal(broad, 1); assert.equal(out.fired, false); assert.equal(f.state.nonces, 1); assert.equal(f.state.signs, 0);
  assert.equal(out.summary.nextBlock.requested, true); assert.equal(out.summary.nextBlock.qualifiedAtAcquisition, true);
  assert.equal(out.summary.nextBlock.enabled, false); assert.equal(out.summary.nextBlock.deadlineValidAtCheck, false);
  assert.equal(out.summary.nextBlock.knownContextInvalid, true); assert.equal(out.summary.nextBlock.remainingMsAtCheck, 0);
  assert.ok(out.summary.nextBlock.lastHeadCheckAt);
});

test("nonstrict acquisition holds M1 without blocking broad unrelated collection", async t => {
  const f = fixture(t, { future: false }); f.pinned.evidence.strictEvidence = false; let broad = 0;
  const out = await f.run({ execute: false, checkOnce: async opts => {
    if (!opts.m1Only) broad++;
    return { pin: { ...PIN, chainId: 1 }, targets: opts.m1Only ? { [m1.ID]: f.row } : {} };
  } });
  assert.equal(broad, 1); assert.equal(out.summary.preflightFailures[0].reason, "M1_STRICT_EVIDENCE_REQUIRED"); assert.equal(f.state.nonces, 0);
});

test("focused collection failure retains sanitized telemetry while a usable base continues broad collection", async t => {
  const f = fixture(t, { future: false }); let broad = 0;
  const out = await f.run({ execute: false, checkOnce: async options => {
    if (options.m1Only) throw new Error("private collector diagnostic");
    broad++; return { pin: { ...PIN, chainId: 1 }, targets: {} };
  } });
  assert.equal(broad, 1); assert.equal(out.summary.focusedError, "EXECUTION_FAILED");
  assert.equal(out.summary.preflightFailures[0].reason, "EXECUTION_FAILED");
  assert.doesNotMatch(JSON.stringify(out.summary), /private collector diagnostic/);
  assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0);
});

test("safe unsigned/nonstrict M1 holds really reach unrelated CURRENT execution in the same runner", async t => {
  const borrower = "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3", weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", zero = "0x" + "00".repeat(20);
  const unrelated = { user: borrower, liquidatableNow: true, readyExecuteMorphoCalldata: runner.UNIFIED_IFACE.encodeFunctionData("executeMorpho", [5n * W, {
    isAaveV3: true, target: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", borrower, debtToken: weth, collateralToken: weth,
    collateralReserveId: 0, debtReserveId: 0, minCollateralSeized: 0, swapKind: 0, swapTarget: zero, swapSpender: zero,
    uniFee: 0, curveI: 0, curveJ: 0, minDebtTokenOut: 0, minProfitDebtToken: W / 100n }]) };
  for (const strict of [false, true]) {
    const f = fixture(t, { future: false, dustToken: m1.DAI }), order = [];
    f.pinned.evidence.strictEvidence = strict;
    const call = f.pinned.call, estimate = f.pinned.estimateGas, receipt = f.pinned.receipt;
    f.pinned.call = async tx => { if (tx.to === runner.DEPLOYED_EXECUTOR) { order.push("unrelated-preflight"); return "0x"; } return call(tx); };
    f.pinned.estimateGas = async tx => tx.to === runner.DEPLOYED_EXECUTOR ? hex(500000) : estimate(tx);
    f.pinned.receipt = async (...args) => ({ ...await receipt(...args), to: runner.DEPLOYED_EXECUTOR, gasUsed: hex(500000) });
    const out = await f.run({ signTransaction: mockSignedTransactionBinding(t).wrapSigner(async tx => {
      order.push("unrelated-sign"); assert.equal(tx.to, runner.DEPLOYED_EXECUTOR); f.state.signs++; return "0x010203";
    }, guard.MAIN_ACCOUNT), checkOnce: async options => {
      order.push(options.m1Only ? "focused" : "broad");
      if (!options.m1Only) assert.equal(f.state.codes, strict ? 1 : 0);
      return { pin: { ...PIN, chainId: 1 }, targets: options.m1Only ? { [m1.ID]: f.row } : { target2K_AaveV3_WETH_WETH_0x7a05: unrelated } };
    } });
    assert.equal(out.fired, true, JSON.stringify(out.summary)); assert.equal(out.summary.execution.intent.targetId, "target2K_AaveV3_WETH_WETH_0x7a05");
    assert.deepEqual(order, ["focused", "broad", "unrelated-preflight", "unrelated-sign"]);
    assert.equal(out.summary.preflightFailures.length, 1); assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1);
    assert.equal(out.summary.targets.length, 2, "fresh focused row stays in the compact summary, never in broad candidates");
  }
});

test("snapshot-time nextBlock status disables an elapsed child after broad collection", async t => {
  const f = fixture(t);
  const out = await f.run({ execute: false, checkOnce: async options => {
    if (!options.m1Only) f.state.now = f.context.timestamp * 1000 + 1;
    return { pin: { ...PIN, chainId: 1 }, targets: { [m1.ID]: f.row } };
  } });
  assert.equal(out.summary.nextBlock.qualifiedAtAcquisition, true); assert.equal(out.summary.nextBlock.enabled, false);
  assert.equal(out.summary.nextBlock.deadlineValidAtCheck, false); assert.equal(out.summary.nextBlock.knownContextInvalid, true);
  assert.equal(out.summary.nextBlock.remainingMsAtCheck, -1); assert.equal(f.state.nonces, 0);
});

function forbidIO(t, f) {
  const forbidden = () => assert.fail("measure-only forbidden IO");
  for (const method of ["reconcileWallet", "executeGuarded", "acquireWalletLock", "signWithProcessKey"]) t.mock.method(guard, method, forbidden);
  for (const method of ["writeFileSync", "mkdirSync", "renameSync", "openSync", "readFileSync", "existsSync"]) t.mock.method(fs, method, forbidden);
  for (const method of ["nonce", "send", "receipt", "estimateGas", "code"]) t.mock.method(f.pinned, method, forbidden);
  // The live fixture's stage detector reads its synthetic journal; the actual
  // base transport recheck is read-only RPC, not a wallet/journal operation.
  t.mock.method(f.pinned, "recheck", async () => { f.state.checks++; });
  t.mock.method(f.pinned.nextBlock, "recheck", forbidden); t.mock.method(f.pinned.nextBlock, "simulate", forbidden);
  return forbidden;
}

test("measure-only rejects execution, forces disarmed/no writes and never acquires future qualification or wallet state", async t => {
  const f = fixture(t), forbidden = forbidIO(t, f); let broad = 0;
  try {
    const out = await f.run({ execute: false, argv: ["--measure-only", "--next-block"], writeOut: true,
      loadBatch: forbidden, loadMorphoBatch: forbidden, signTransaction: forbidden, m1ReadFile: forbidden, amendmentReadFile: forbidden,
      checkOnce: async options => { assert.equal(options.nextBlockContext, null); assert.equal(options.writeOut, false); if (!options.m1Only) broad++;
        return { pin: { ...PIN, chainId: 1 }, targets: { [m1.ID]: f.row } }; } });
    assert.equal(broad, 1); assert.equal(out.summary.armed, false); assert.equal(out.summary.mode, "MEASURE_ONLY");
    assert.equal(out.summary.measurements.exactExecution, "NOT_MEASURED_NONCE_FORBIDDEN");
    const calls = [];
    await runner.connectForPass({ argv: ["--measure-only", "--next-block"], candidates: [], rpc: forbidden, create: async options => { calls.push(options); return f.pinned; } });
    assert.equal(calls.length, 1); assert.equal(calls[0].requireStrictEvidence, true); assert.equal(calls[0].requireNextBlock, undefined);
    await assert.rejects(f.run({ argv: ["--measure-only"], writeOut: true }), /MEASURE_ONLY_EXECUTION_FORBIDDEN/);
    assert.throws(() => runner.parseRunnerMode(["--measure-only", "--execute-if-liquidatable"]), /MEASURE_ONLY_EXECUTION_FORBIDDEN/);
  } finally { t.mock.restoreAll(); }
});

test("measure-only uses actual production focused/broad collector dispatch, including sanitized error paths with no writes", async t => {
  const f = fixture(t), c = focusedFixture(), forbidden = forbidIO(t, f); let broadCalls = 0;
  f.pinned.collectorOptions = { ...c.collectorOptions, rpcCall: async (rpc, method, params) => {
    if (method === "eth_getBlockByNumber") { broadCalls++; throw new guard.ExecutionError("OFFLINE_BROAD_UNAVAILABLE"); }
    return c.collectorOptions.rpcCall(rpc, method, params);
  } };
  // The actual runner provides m1Only only to its focused call, not broad.
  delete f.pinned.collectorOptions.m1Only;
  try {
    await assert.rejects(f.run({ execute: false, argv: ["--measure-only", "--next-block"], writeOut: true, checkOnce: undefined,
      loadBatch: forbidden, loadMorphoBatch: forbidden, signTransaction: forbidden }), error => {
      assert.equal(error.passSummary.mode, "MEASURE_ONLY"); assert.equal(error.passSummary.armed, false);
      assert.equal(error.passSummary.partial, true); assert.equal(error.passSummary.targets.length, 1);
      assert.equal(error.passSummary.reason, "OFFLINE_BROAD_UNAVAILABLE"); return true;
    });
    assert.equal(c.calls.length, 2); assert.equal(broadCalls, 1);
    const output = [], oldExit = process.exitCode;
    try { await runner.main(["--measure-only", "--next-block"], { loadCandidates: () => [], connect: async () => { throw new Error("not-a-safe-provider-message"); }, output: value => output.push(value) }); }
    finally { process.exitCode = oldExit; }
    assert.equal(output.length, 1); assert.equal(output[0].armed, false); assert.doesNotMatch(JSON.stringify(output), /not-a-safe-provider-message/);
    assert.equal(output[0].measurements.futureQualification, "NOT_MEASURED_NONCE_FORBIDDEN");
  } finally { t.mock.restoreAll(); }
});

test("phase timings are bounded monotonic scalar phases, include failed boundaries and preserve transport identity", async t => {
  let ticks = 0;
  const timings = runner.createPhaseTimings({ now: () => NOW, monotonic: () => ticks++ }), end = timings.begin("acquisition"); end(PIN);
  const f = fixture(t, { future: false }), methods = [f.pinned.call, f.pinned.code, f.pinned.estimateGas, f.pinned.recheck, f.pinned.nextBlock.simulate];
  const out = await f.run({ timings }), times = out.summary.phaseTimingsMs;
  assert.equal(out.fired, true); assert.ok(times.total >= times.acquisition); assert.ok(times.boundaries.length <= 24);
  assert.equal(times.boundaries[1].parentAgeMs, 3000); assert.equal(times.boundaries[1].childHeadroomMs, 9000);
  assert.deepEqual([f.pinned.call, f.pinned.code, f.pinned.estimateGas, f.pinned.recheck, f.pinned.nextBlock.simulate], methods);
  for (let i = 1; i < times.boundaries.length; i++) assert.ok(times.boundaries[i].elapsedMs >= times.boundaries[i - 1].elapsedMs);
});

function assertM1Only(summary, users = [m1.BORROWER]) {
  assert.equal(summary.collectionScope, "M1_ONLY"); assert.equal(summary.partition, "M1_ONLY"); assert.equal(summary.partial, true);
  assert.deepEqual(summary.targets.map(row => row.user), users);
  assert.equal(summary.phaseTimingsMs.broadCollection, null);
  assert.ok(summary.phaseTimingsMs.boundaries.every(row => row.phase !== "broadCollection"));
}

test("M1-only parsing is independent of execution and measurement", () => {
  assert.equal(runner.parseRunnerMode([]).m1Only, false);
  for (const flags of [[], ["--execute"], ["--measure-only", "--next-block"]]) {
    const mode = runner.parseRunnerMode(["--m1-only", ...flags]);
    assert.equal(mode.m1Only, true); assert.equal(mode.execute, flags.includes("--execute"));
    assert.equal(mode.measureOnly, flags.includes("--measure-only"));
  }
  assert.throws(() => runner.parseRunnerMode(["--m1-only", "--measure-only", "--execute"]), /MEASURE_ONLY_EXECUTION_FORBIDDEN/);
});

for (const scenario of [
  { name: "healthy", row: row => ({ ...row, liquidatableNow: false, executableNow: false }) },
  { name: "no candidate", absent: true },
  { name: "collection error", collectionError: true, reason: "EXECUTION_FAILED", absent: true },
  { name: "stale collector pin", stale: true, reason: "COLLECTOR_PIN_MISMATCH", absent: true },
  { name: "admission error", row: row => ({ ...row, readyExecuteMorphoBlueCalldata: calldata({ profit: 1n }) }), reason: "PLAN_PROFIT_OR_SLIPPAGE_INVALID" },
  { name: "nonstrict evidence", nonstrict: true, reason: "M1_STRICT_EVIDENCE_REQUIRED" },
  { name: "unsigned inventory hold", options: { dustToken: m1.DAI }, reason: "M1_EXECUTOR_INVENTORY_NONZERO" },
  { name: "runtime gate rejection", options: { runtime: "0x" }, reason: "M1_RUNTIME_BINDING_REQUIRED" },
  { name: "final economics hold", options: { ethUsd: 8175400000000n }, reason: "M1_NET_NONPOSITIVE" },
]) {
  test(`M1-only ${scenario.name}: zero broad calls, fresh scoped telemetry, observation bytes unchanged`, async t => {
    const f = fixture(t, { future: false, ...scenario.options }), calls = [];
    if (scenario.nonstrict) f.pinned.evidence.strictEvidence = false;
    const observationFile = path.join(f.root, "observation.json"), statusFile = path.join(f.root, "status.json");
    const previous = Buffer.from('{"targets":{"stale-broad":{"armed":true},"targetM1_Morpho_USDe_DAI":{"rank":"STALE"}}}\n');
    fs.writeFileSync(observationFile, previous);
    const fresh = { ...(scenario.row ? scenario.row(f.row) : f.row), rank: "FRESH-M1" };
    const out = await f.run({ argv: ["--m1-only"], writeOut: true, observationFile, statusFile,
      checkOnce: async options => {
        calls.push(options.m1Only ? "focused" : "broad"); assert.equal(options.m1Only, true); assert.equal(options.writeOut, false);
        if (scenario.collectionError) throw new Error("private focused diagnostic");
        return { pin: { ...PIN, chainId: 1, ...(scenario.stale ? { number: PIN.number - 1 } : {}) }, targets: {
          ...(scenario.absent && !scenario.stale ? {} : { [m1.ID]: fresh }),
          unrelated: { user: "0x" + "12".repeat(20), rank: "UNRELATED", armed: true, liquidatableNow: true },
        } };
      } });
    assert.deepEqual(calls, ["focused"]); assert.equal(out.fired, false); assert.equal(out.summary.armed, false);
    assert.equal(out.summary.mode, "EXECUTE_IF_LIQUIDATABLE"); assertM1Only(out.summary, scenario.absent ? [] : [m1.BORROWER]);
    assert.deepEqual(fs.readFileSync(observationFile), previous);
    assert.deepEqual(JSON.parse(fs.readFileSync(statusFile)).targets, JSON.parse(JSON.stringify(out.summary.targets)));
    assert.doesNotMatch(JSON.stringify(out.summary), /STALE|UNRELATED|private focused diagnostic/);
    if (!scenario.absent) assert.equal(out.summary.targets[0].rank, "FRESH-M1");
    if (scenario.reason) {
      assert.equal(out.summary.preflightFailures[0].reason, scenario.reason);
      assert.equal(out.summary.reason, "NO_CANDIDATE_PASSED_PREFLIGHT");
    }
    assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0); assert.equal(f.journalExists(), false);
    if (scenario.absent) { assert.equal(out.summary.candidateCount, 0); assert.equal(f.state.nonces, 0); assert.equal(f.state.codes, 0); }
  });
}

for (const future of [false, true]) {
  test(`M1-only ${future ? "child" : "CURRENT"} real guarded mocked signing succeeds; replay stays held without broad collection`, async t => {
    const f = fixture(t, { future }), calls = [], observationFile = path.join(f.root, "observation.json"), statusFile = path.join(f.root, "status.json");
    fs.writeFileSync(observationFile, "UNCHANGED");
    const options = { argv: ["--m1-only", ...(future ? ["--next-block"] : [])], writeOut: true, observationFile, statusFile,
      checkOnce: async opts => { calls.push(opts.m1Only); assert.equal(opts.m1Only, true);
        return { pin: { ...PIN, chainId: 1 }, targets: { [m1.ID]: f.row, unrelated: { user: "unrelated", armed: true } } }; } };
    const out = await f.run(options);
    assert.equal(out.fired, true, JSON.stringify(out.summary)); assertM1Only(out.summary);
    assert.equal(out.summary.execution.stage, "RECEIPT_VERIFIED"); assert.equal(out.summary.armed, true);
    assert.equal(out.summary.execution.intent.targetId, m1.ID); assert.ok(out.summary.execution.intent.m1LiveProof);
    assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1); assert.equal(f.state.codes, 1);
    for (const time of Object.values(out.summary.phaseTimingsMs.preparation)) assert.equal(typeof time, "number");
    const again = await f.run(options);
    assertM1Only(again.summary); assert.equal(again.fired, false); assert.equal(again.summary.armed, false);
    assert.equal(again.summary.preflightFailures[0].reason, "M1_TRIGGER_EVENT_ALREADY_ATTEMPTED");
    assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1); assert.deepEqual(calls, [true, true]);
    assert.equal(fs.readFileSync(observationFile, "utf8"), "UNCHANGED");
  });
}

test("M1-only signer/send failures still end the pass with scoped disarmed telemetry", async t => {
  for (const outcome of ["signer", "send"]) {
    const f = fixture(t, { future: false }); let calls = 0, signerCalls = 0;
    if (outcome === "send") f.pinned.send = async () => { throw new guard.ExecutionError("OFFLINE_SEND_FAILURE"); };
    const out = await f.run({ argv: ["--m1-only"],
      ...(outcome === "signer" ? { signTransaction: async () => { signerCalls++; throw new guard.ExecutionError("OFFLINE_SIGNER_FAILURE"); } } : {}),
      checkOnce: async options => { calls++; assert.equal(options.m1Only, true); return { pin: { ...PIN, chainId: 1 }, targets: { [m1.ID]: f.row } }; } });
    assertM1Only(out.summary); assert.equal(calls, 1); assert.equal(out.fired, false); assert.equal(out.summary.armed, false);
    assert.equal(out.summary.reason, "SIGNED_ATTEMPT_ENDED_PASS"); assert.equal(signerCalls + f.state.signs, 1);
  }
});

test("M1-only poisoned pin still throws after unsigned preparation, with no broad call", async t => {
  const f = fixture(t, { future: false, afterNonce: (_state, pinned) => {
    pinned.assertUsable = () => { throw new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED"); };
  } }); let calls = 0;
  await assert.rejects(f.run({ argv: ["--m1-only"], checkOnce: async options => {
    calls++; assert.equal(options.m1Only, true); return { pin: { ...PIN, chainId: 1 }, targets: { [m1.ID]: f.row } };
  } }), error => {
    assertM1Only(error.passSummary); assert.equal(error.passSummary.armed, false); assert.equal(error.passSummary.mode, "BLOCKED");
    return error.code === "PIN_EVIDENCE_INVALIDATED";
  });
  assert.equal(calls, 1); assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0);
});

test("M1-only measurement uses the real focused collector without broad/nonce/key/sign/write or future qualification", async t => {
  const f = fixture(t), c = focusedFixture(), forbidden = forbidIO(t, f);
  f.pinned.collectorOptions = { ...c.collectorOptions };
  delete f.pinned.collectorOptions.m1Only;
  try {
    const argv = ["--measure-only", "--m1-only", "--next-block"], calls = [];
    await runner.connectForPass({ argv, candidates: [], rpc: forbidden,
      create: async options => { calls.push(options); return f.pinned; } });
    assert.equal(calls.length, 1); assert.equal(calls[0].requireStrictEvidence, true); assert.equal(calls[0].requireNextBlock, undefined);
    const out = await f.run({ execute: false, argv, writeOut: true, checkOnce: undefined,
      loadBatch: forbidden, loadMorphoBatch: forbidden, signTransaction: forbidden, m1ReadFile: forbidden, amendmentReadFile: forbidden });
    assertM1Only(out.summary); assert.equal(out.summary.mode, "MEASURE_ONLY"); assert.equal(out.summary.armed, false);
    assert.equal(out.summary.measurements.fullPreparation, "NOT_MEASURED_NONCE_FORBIDDEN");
    assert.equal(out.summary.measurements.exactExecution, "NOT_MEASURED_NONCE_FORBIDDEN");
    assert.equal(out.summary.measurements.futureQualification, "NOT_MEASURED_NONCE_FORBIDDEN");
    assert.ok(c.calls.length > 0); assert.equal(f.state.nonces, 0); assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0);
    assert.equal(typeof out.summary.phaseTimingsMs.focusedM1Collection, "number"); assert.equal(typeof out.summary.phaseTimingsMs.admission, "number");
    assert.ok(Object.values(out.summary.phaseTimingsMs.preparation).every(time => time === null));
  } finally { t.mock.restoreAll(); }
});
