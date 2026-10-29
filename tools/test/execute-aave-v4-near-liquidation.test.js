"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { keccak256 } = require("../node_modules/ethers");
const guard = require("../lib/wallet-execution-guard.js");
const { createPinnedRpc, MULTICALL3, PROBE } = require("../lib/executor-pinned-rpc.js");
const near = require("../execute-aave-v4-near-liquidation.js");

const NOW = Date.parse("2026-10-19T22:00:00Z"), PIN = 26229263, PIN_TIME = NOW / 1000 - 12, OWNER = guard.MAIN_ACCOUNT;
const hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0"), hex = n => "0x" + BigInt(n).toString(16);
const ETH_FEED = "0x" + "11".repeat(20), USDC_FEED = "0x" + "22".repeat(20);
const ENABLED_IDS = ["rank1_usdc_usdc_0x014e", "rank5_usdc_usdc_0x0d3f"];
const HELD_TARGETS = [{ targetId: "rank2_wsteth_weth_0x4cd7", reason: "SLIPPAGE_PREFLIGHT_HOLD" }];

function temp(t) {
  const base = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "near-liq-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, lockRoot: path.join(root, "locks"), journalDir: path.join(root, "journal"), receiptWaitMs: 0 };
}

// Entirely synthetic approval, feed addresses, prices and economics. Never read or modify the live batch.
function makeBatch() {
  return {
    schema: "live-execution-batch/v1", batchId: "SYNTHETIC_OFFLINE_TEST_ONLY", approved: true,
    expiresAt: "2026-10-20T22:00:00Z", chain: "ethereum", chainId: 1, account: { address: OWNER },
    targets: near.REQUIRED_TARGETS.map(address => ({ address })),
    actions: near.NEAR_TARGET_PLANS.map(p => ({
      permission: "EXECUTE_ON_TRIGGER", targetId: p.id, method: p.executorKind === "UNIFIED" ? "executeMorpho" : "execute",
      executor: p.executor, spoke: p.spoke, borrower: p.borrower, collateralAsset: p.collateralAsset, debtAsset: p.debtAsset,
      collateralReserveId: p.collateralReserveId.toString(), debtReserveId: p.debtReserveId.toString(),
      flashLoanAmount: p.flashLoanAmount.toString(), debtToCover: p.debtToCover.toString(), minProfit: p.minProfit.toString(),
      slippage: p.executorKind === "UNIFIED" ? { mode: "NO_SWAP_SAME_ASSET", minSwapOutRaw: "0" }
        : { mode: "QUOTE_RELATIVE", maxSlippageBps: 50, minSwapOutRaw: p.minSwapOut.toString() }
    })),
    caps: { valueCapEth: "0", maxExecuteGasLimit: 1200000, maxFeePerGasWei: "250000000", maxNativeSpendPerTransactionWei: "300000000000000",
      signedExecutionsPerDay: 3, maxSwapSlippageBps: 50, minProfitUsdcRaw: "5000000", minProfitWethRaw: "2000000000000000", principalAtRisk: "zero (atomic synthetic test)" },
    economics: { schema: "near-liquidation-economics/v1", additionalReserveUsdcRaw: "50000", additionalReserveWethRaw: "10000000000000", profitHaircutBps: "100",
      ethUsdFeed: { address: ETH_FEED, decimals: 8, maxAgeSeconds: 60 }, usdcUsdFeed: { address: USDC_FEED, decimals: 8, maxAgeSeconds: 60 } }
  };
}

async function fixture(t, options = {}) {
  const counters = { signed: 0, sent: 0, nonce: 0, estimated: 0, oracleReads: 0 }, calls = [], signedTransactions = [];
  const batch = makeBatch(), executionOptions = temp(t), now = options.now || (() => NOW);
  let lastTo = null;
  const candidates = [1, 2].map(n => ({ handle: "OFFLINE_" + n, family: "synthetic-" + n }));
  const feeds = {
    [ETH_FEED]: { decimals: 8, description: "ETH / USD", answer: 240000000000n, ...options.eth },
    [USDC_FEED]: { decimals: 8, description: "USDC / USD", answer: 99000000n, ...options.usdc }
  };
  async function rpc(candidate, method, params) {
    calls.push({ family: candidate.family, method, params });
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return { number: hex(PIN), hash: hash(PIN), parentHash: hash(PIN - 1), stateRoot: hash(7), timestamp: hex(PIN_TIME), baseFeePerGas: hex(115000000) };
    if (method === "eth_getTransactionCount") { counters.nonce++; return "0x5"; }
    if (method === "eth_sendRawTransaction") { counters.sent++; return keccak256(params[0]); }
    if (method === "eth_getTransactionReceipt") return options.pendingReceipt ? null : {
      transactionHash: params[0], from: OWNER, to: options.receiptTo || lastTo, blockHash: hash(PIN + 1), blockNumber: hex(PIN + 1), transactionIndex: "0xa",
      status: "0x1", gasUsed: hex(450000), effectiveGasPrice: hex(115000000), logs: []
    };
    if (["eth_call", "eth_estimateGas"].includes(method)) assert.deepEqual(params[1], { blockHash: hash(PIN), requireCanonical: true });
    if (method === "eth_estimateGas") { counters.estimated++; return hex(500000); }
    if (method === "eth_call") {
      const call = params[0];
      if (call.to === MULTICALL3 && call.data === PROBE.encodeFunctionData("getBlockNumber")) return hash(PIN);
      if (call.to === MULTICALL3) {
        const decoded = near.MULTICALL_IFACE.decodeFunctionData("aggregate3", call.data)[0];
        assert.equal(decoded.length, 3);
        return near.MULTICALL_IFACE.encodeFunctionResult("aggregate3", [decoded.map((_, i) => {
          const fired = options.fired === "all" || (Array.isArray(options.fired) ? options.fired.includes(i) : i === (options.fired ?? 0));
          return { success: true, returnData: near.DEDICATED_IFACE.encodeFunctionResult("previewHealthFactor", [
            fired ? 999950000000000000n : 1001000000000000000n, fired, 20000000000000000000000000000n, 15600000000000000000000000000n
          ]) };
        })]);
      }
      if (feeds[call.to]) {
        counters.oracleReads++;
        if (options.oracleUnavailable) throw new guard.ExecutionError("CALL_REVERTED");
        const f = feeds[call.to], name = near.FEED_IFACE.parseTransaction({ data: call.data }).name;
        if (f.malformed === name) return "0x";
        if (name === "decimals" || name === "description") return near.FEED_IFACE.encodeFunctionResult(name, [f[name]]);
        const answer = options.disagree && candidate.family === "synthetic-2" ? f.answer + 1n : f.answer;
        return near.FEED_IFACE.encodeFunctionResult(name, [f.roundId ?? 7n, answer, f.startedAt ?? PIN_TIME - 30, f.updatedAt ?? PIN_TIME - 30, f.answeredInRound ?? 7n]);
      }
      if (call.to === near.UNIFIED_LIQUIDATOR) return options.unifiedResult ?? "0x";
      if (call.to === near.DEDICATED_V4_LIQUIDATOR) return near.DEDICATED_IFACE.encodeFunctionResult("execute", [options.simulatedProfit ?? 3305017393387660n]);
    }
    throw new Error("Unexpected offline method: " + method);
  }
  const pinned = await createPinnedRpc({ candidates, rpc, now });
  const signTransaction = async tx => { counters.signed++; signedTransactions.push(tx); lastTo = tx.to; return "0x010203"; };
  return { batch, counters, calls, signedTransactions, pinned, executionOptions, feeds,
    run: changes => near.runOnce({ execute: true, pinned, batch, now, executionOptions, signTransaction, ...changes }) };
}

test("synthetic approval binds all three unchanged plans; missing or revoked authorization cannot arm", async t => {
  const f = await fixture(t);
  for (const approved of [false, undefined]) {
    const pending = makeBatch(); pending.approved = approved;
    assert.throws(() => near.validateAuthorization(pending, NOW), /BATCH_INVALID_OR_EXPIRED/);
    await assert.rejects(f.run({ batch: pending }), /BATCH_INVALID_OR_EXPIRED/);
  }
  assert.equal(f.counters.signed, 0);
  assert.equal(f.counters.nonce, 0); assert.equal(f.counters.sent, 0);
  const caps = near.validateAuthorization(makeBatch(), NOW);
  assert.equal(caps.minProfitUsdc, 5000000n); assert.equal(caps.minProfitWeth, 2000000000000000n);
  assert.deepEqual(near.NEAR_TARGET_PLANS.map(p => p.id), ["rank1_usdc_usdc_0x014e", "rank2_wsteth_weth_0x4cd7", "rank5_usdc_usdc_0x0d3f"]);
});

test("borrower, executor, spoke, affirmative action, amount and explicit slippage permissions fail closed", () => {
  const invalid = [
    [b => { b.actions = ["execute", "liquidate"]; }, "BATCH_ACTION_NOT_APPROVED"],
    [b => { b.actions[0].permission = "DO_NOT_EXECUTE"; }, "BATCH_ACTION_NOT_APPROVED"],
    [b => { b.actions[0].borrower = OWNER; }, "BATCH_ACTION_NOT_APPROVED"],
    [b => { b.actions[0].spoke = b.actions[2].spoke; }, "BATCH_ACTION_NOT_APPROVED"],
    [b => { b.actions[1].executor = near.UNIFIED_LIQUIDATOR; }, "BATCH_ACTION_NOT_APPROVED"],
    [b => { b.actions[1].method = "executeBatch"; }, "BATCH_ACTION_NOT_APPROVED"],
    [b => { b.actions[2].flashLoanAmount = "1"; }, "BATCH_ACTION_NOT_APPROVED"],
    [b => { b.actions.push(b.actions[0]); }, "BATCH_ACTION_NOT_APPROVED"],
    [b => { b.targets.pop(); }, "BATCH_TARGET_NOT_APPROVED"],
    [b => { delete b.actions[1].slippage; }, "BATCH_SLIPPAGE_NOT_APPROVED"],
    [b => { b.actions[1].slippage.minSwapOutRaw = "0"; }, "BATCH_SLIPPAGE_NOT_APPROVED"],
    [b => { b.actions[1].slippage.mode = "ASSUMED_50_BPS"; }, "BATCH_SLIPPAGE_NOT_APPROVED"],
    [b => { b.actions[1].slippage.mode = "ABSOLUTE_MIN_OUT"; }, "BATCH_SLIPPAGE_NOT_APPROVED"],
    [b => { b.actions[0].slippage.mode = "ABSOLUTE_MIN_OUT"; }, "BATCH_SLIPPAGE_NOT_APPROVED"]
  ];
  for (const [edit, code] of invalid) { const b = makeBatch(); edit(b); assert.throws(() => near.validateAuthorization(b, NOW), { code }); }
});

test("quote-relative slippage binds an explicit numeric 0..50bps action and batch cap without defaults", () => {
  for (const maxSlippageBps of [0, 1, 49, 50]) {
    const b = makeBatch();
    b.caps.maxSwapSlippageBps = b.actions[1].slippage.maxSlippageBps = maxSlippageBps;
    assert.equal(near.validateAuthorization(b, NOW).maxSwapSlippageBps, maxSlippageBps);
    assert.equal(b.actions[1].slippage.minSwapOutRaw, "375000000000000000");
  }
  for (const value of [undefined, null, -1, 51, 0.5, "50", NaN, Infinity]) {
    for (const field of ["cap", "action", "both"]) {
      const b = makeBatch();
      if (field !== "action") b.caps.maxSwapSlippageBps = value;
      if (field !== "cap") b.actions[1].slippage.maxSlippageBps = value;
      assert.throws(() => near.validateAuthorization(b, NOW), /BATCH_SLIPPAGE_NOT_APPROVED/);
    }
  }
  for (const [cap, action] of [[49, 50], [50, 49]]) {
    const b = makeBatch(); b.caps.maxSwapSlippageBps = cap; b.actions[1].slippage.maxSlippageBps = action;
    assert.throws(() => near.validateAuthorization(b, NOW), /BATCH_SLIPPAGE_NOT_APPROVED/);
  }
});

test("economics has no implicit reserves, haircut, feeds, decimals or freshness defaults", () => {
  const b = makeBatch(); delete b.economics;
  assert.throws(() => near.validateAuthorization(b, NOW), /BATCH_ECONOMICS_REQUIRED/);
  for (const key of ["additionalReserveUsdcRaw", "additionalReserveWethRaw", "profitHaircutBps"]) {
    for (const value of [undefined, null, -1, "-1", "1.1", "01", 1, (1n << 256n).toString()]) {
      const policy = makeBatch().economics; policy[key] = value;
      assert.throws(() => near.validateEconomicsPolicy(policy), /BATCH_ECONOMICS_INVALID/);
    }
  }
  const haircut = makeBatch().economics; haircut.profitHaircutBps = "10001";
  assert.throws(() => near.validateEconomicsPolicy(haircut), /BATCH_ECONOMICS_INVALID/);
  for (const key of ["ethUsdFeed", "usdcUsdFeed"]) {
    for (const edit of [p => { delete p[key]; }, p => { delete p[key].decimals; }, p => { p[key].address = "0x" + "00".repeat(20); },
      p => { p[key].address = "invalid"; }, p => { p[key].decimals = 19; }, p => { p[key].decimals = 1.5; },
      p => { p[key].maxAgeSeconds = 0; }, p => { delete p[key].maxAgeSeconds; }]) {
      const policy = makeBatch().economics; edit(policy); assert.throws(() => near.validateEconomicsPolicy(policy), /BATCH_ORACLE_POLICY_INVALID/);
    }
  }
  const sameFeed = makeBatch().economics; sameFeed.usdcUsdFeed.address = sameFeed.ethUsdFeed.address;
  assert.throws(() => near.validateEconomicsPolicy(sameFeed), /BATCH_ORACLE_POLICY_INVALID/);
  const explicitZero = makeBatch().economics;
  explicitZero.additionalReserveUsdcRaw = explicitZero.additionalReserveWethRaw = explicitZero.profitHaircutBps = "0";
  assert.equal(near.validateEconomicsPolicy(explicitZero).profitHaircutBps, "0");
});

test("healthy execution and pending check-only never touch keys or a signer; check-only never reconciles or requests a nonce", async t => {
  let keyAccesses = 0, signerAccesses = 0;
  const readFile = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function(file, ...args) {
    assert.doesNotMatch(String(file), /(?:\.env|rpc_endpoints|keypair|\.pem)/i);
    return readFile.call(this, file, ...args);
  });
  t.mock.method(guard, "signWithProcessKey", async () => { keyAccesses++; throw new Error("Unexpected key loader"); });
  const healthy = await fixture(t, { fired: -1 });
  const h = await healthy.run({ signTransaction: undefined });
  assert.equal(h.firedCount, 0); assert.equal(h.netEvaluation, "NOT_EVALUATED_HEALTHY");
  assert.equal(h.armed, true); assert.deepEqual(h.enabledTargetIds, ENABLED_IDS); assert.deepEqual(h.armedTargetIds, ENABLED_IDS);
  assert.deepEqual(h.heldTargets, HELD_TARGETS); assert.deepEqual(h.heldTriggers, []);
  assert.deepEqual(h.targets.map(p => p.readinessStatus), ["READY_FOR_TRIGGER_PREFLIGHT", "SLIPPAGE_PREFLIGHT_HOLD", "READY_FOR_TRIGGER_PREFLIGHT"]);
  assert.equal(healthy.counters.nonce, 0); assert.equal(healthy.counters.oracleReads, 0);
  t.mock.method(guard, "reconcileWallet", async () => { throw new Error("Check-only must not reconcile"); });
  const unconfigured = makeBatch(); unconfigured.approved = false; delete unconfigured.economics;
  const pending = await healthy.run({ execute: false, argv: ["--check"], batch: unconfigured, signTransaction: undefined });
  assert.equal(pending.armed, false); assert.equal(pending.mode, "CHECK_ONLY");
  assert.deepEqual(pending.armedTargetIds, []); assert.deepEqual(pending.enabledTargetIds, ENABLED_IDS);
  assert.deepEqual(pending.targets.map(p => p.readinessStatus), ["BLOCKED_POLICY", "SLIPPAGE_PREFLIGHT_HOLD", "BLOCKED_POLICY"]);
  assert.equal(pending.executionAuthorization.valid, false);
  assert.ok(pending.readinessFailures.includes("BATCH_ECONOMICS_REQUIRED"));
  assert.equal(pending.netEvaluation, "BLOCKED_POLICY");
  const f = await fixture(t, { fired: "all" }); f.batch.approved = false;
  const out = await f.run({ execute: false, argv: ["--check"], signTransaction: async () => { signerAccesses++; throw new Error("Unexpected signer"); } });
  assert.equal(out.preflightResults.length, 2); assert.equal(out.preflightFailures.length, 0);
  assert.equal(out.armed, false); assert.equal(out.executionAuthorization.valid, false);
  assert.deepEqual(out.armedTargetIds, []); assert.deepEqual(out.heldTriggers, HELD_TARGETS);
  assert.equal(out.reason, "CHECK_ONLY_NO_SIGNING"); assert.equal(out.execution, undefined);
  assert.equal(f.counters.nonce, 0); assert.equal(f.counters.sent, 0);
  assert.equal(fs.existsSync(f.executionOptions.lockRoot), false); assert.equal(fs.existsSync(f.executionOptions.journalDir), false);
  assert.equal(keyAccesses, 0); assert.equal(signerAccesses, 0);
});

for (const fired of [0, 2]) {
  test(`${near.NEAR_TARGET_PLANS[fired].id} alone reaches guarded execution with unchanged calldata, floors and positive conditional net`, async t => {
    const f = await fixture(t, { fired }), out = await f.run(), intent = out.execution.intent, estimate = intent.netEstimate;
    const template = near.NEAR_TARGET_PLANS[fired], floor = fired === 0 ? 5000000n : 20000000n;
    const expectedData = near.UNIFIED_IFACE.encodeFunctionData("executeMorpho", [fired === 0 ? 165000000n : 1500000000n, [
      false, template.spoke, template.borrower, template.debtAsset, template.collateralAsset,
      fired === 0 ? 7n : 1n, fired === 0 ? 7n : 1n, floor, 0, "0x" + "00".repeat(20), "0x" + "00".repeat(20), 0, 0, 0, 0n, floor
    ]]);
    assert.equal(f.signedTransactions[0].data, expectedData); assert.equal(f.signedTransactions[0].value, 0n);
    assert.equal(intent.calldataHash, keccak256(expectedData));
    assert.equal(intent.contractEnforcedProfitFloorBeforeGasRaw, floor.toString());
    assert.equal(out.execution.stage, "RECEIPT_VERIFIED"); assert.equal(intent.targetId, near.NEAR_TARGET_PLANS[fired].id);
    assert.equal(f.counters.signed, 1); assert.equal(f.counters.sent, 1);
    assert.deepEqual(out.enabledTargetIds, ENABLED_IDS); assert.deepEqual(out.armedTargetIds, ENABLED_IDS);
    assert.deepEqual(out.heldTargets, HELD_TARGETS); assert.deepEqual(out.heldTriggers, []);
    assert.equal(estimate.nativeGasBudgetWei, "150000000000000");
    assert.equal(estimate.gasCostProfitTokenRaw, "363637");
    assert.equal(estimate.netLowerBoundProfitTokenRaw, fired === 0 ? "4536363" : "19386363");
    assert.equal(estimate.positive, true); assert.equal(estimate.prices.ethUsd.address, ETH_FEED);
    assert.equal(estimate.pin.hash, hash(PIN)); assert.equal(estimate.realizedNetProfit, "UNKNOWN");
    assert.equal(out.execution.realizedNetProfit, "UNKNOWN"); assert.equal(out.execution.actualTokenGainRaw, null);
    assert.match(estimate.limitations, /Failed-transaction gas and competition losses are NOT eliminated/);
    assert.equal(intent.simulatedProfitBeforeGasRaw, undefined);
    assert.equal(intent.simulation.kind, "NO_RETURN_SUCCESS_CONTRACT_ENFORCED_LOWER_BOUND");
    assert.equal(intent.simulation.simulatedProfitBeforeGasRaw, undefined);
    for (const address of [ETH_FEED, USDC_FEED, near.UNIFIED_LIQUIDATOR]) {
      const families = new Set(f.calls.filter(c => c.method === "eth_call" && c.params[0].to === address).map(c => c.family));
      assert.equal(families.size, 2);
    }
    for (const c of f.calls.filter(c => ["eth_call", "eth_estimateGas"].includes(c.method) && c.params[0].to === near.UNIFIED_LIQUIDATOR)) {
      assert.equal(c.params[0].data, expectedData);
    }
  });
}

test("rank2-only trigger stays authorized but held, with no execution calldata, preflight, nonce, signer or submission, and keeps the watch armed", async t => {
  const encode = near.DEDICATED_IFACE.encodeFunctionData;
  t.mock.method(near.DEDICATED_IFACE, "encodeFunctionData", function(name, ...args) {
    assert.notEqual(name, "execute"); return encode.call(this, name, ...args);
  });
  t.mock.method(guard, "executeGuarded", async () => { assert.fail("Held target must not reach guarded execution"); });
  const f = await fixture(t, { fired: 1 });
  // Extra flags or policy metadata cannot waive the unconditional hold.
  f.batch.actions[1].slippage.preflightPassed = true;
  for (let iteration = 0; iteration < 2; iteration++) {
    const out = await f.run({ argv: ["--loop", "--allow-held-targets"] });
    assert.equal(out.ok, true); assert.equal(out.armed, true); assert.equal(out.executionAuthorization.valid, true);
    assert.equal(out.firedCount, 1); assert.equal(out.targets.length, 3);
    assert.deepEqual(out.enabledTargetIds, ENABLED_IDS); assert.deepEqual(out.armedTargetIds, ENABLED_IDS);
    assert.deepEqual(out.heldTargets, HELD_TARGETS); assert.deepEqual(out.heldTriggers, HELD_TARGETS);
    assert.equal(out.targets[1].readinessStatus, "SLIPPAGE_PREFLIGHT_HOLD");
    assert.equal(out.reason, "SLIPPAGE_PREFLIGHT_HOLD"); assert.equal(out.netEvaluation, "SLIPPAGE_PREFLIGHT_HOLD");
    assert.equal(out.execution, undefined);
    assert.equal(Boolean(out.execution || out.armed === false), false, "main loop must not take its termination branch");
  }
  assert.deepEqual(f.counters, { signed: 0, sent: 0, nonce: 0, estimated: 0, oracleReads: 0 });
  assert.equal(f.calls.some(c => c.method === "eth_call" && [near.UNIFIED_LIQUIDATOR, near.DEDICATED_V4_LIQUIDATOR].includes(c.params[0].to)), false);
  assert.equal(fs.existsSync(f.executionOptions.journalDir), false);
});

test("mixed held rank2 and enabled rank5 triggers do not block rank5 guarded execution", async t => {
  const f = await fixture(t, { fired: [1, 2] }), out = await f.run();
  assert.equal(out.firedCount, 2); assert.deepEqual(out.heldTriggers, HELD_TARGETS);
  assert.equal(out.execution.intent.targetId, ENABLED_IDS[1]); assert.equal(out.execution.stage, "RECEIPT_VERIFIED");
  assert.deepEqual(out.preflightResults.map(p => p.targetId), [ENABLED_IDS[1]]); assert.deepEqual(out.preflightFailures, []);
  assert.equal(out.execution.intent.contractEnforcedProfitFloorBeforeGasRaw, "20000000");
  assert.equal(f.counters.signed, 1); assert.equal(f.counters.sent, 1);
  assert.equal(f.calls.some(c => ["eth_call", "eth_estimateGas"].includes(c.method) && c.params[0].to === near.DEDICATED_V4_LIQUIDATOR), false);
});

test("zero and negative net block each enabled USDC target before nonce/signing and retain the bounded estimate", async t => {
  for (const fired of [0, 2]) for (const loss of [0n, 1n]) {
    const f = await fixture(t, { fired });
    f.batch.economics.additionalReserveUsdcRaw = ((fired === 0 ? 4586363n : 19436363n) + loss).toString();
    const out = await f.run();
    assert.equal(out.reason, "NO_FIRED_TARGET_PASSED_PREFLIGHT");
    assert.equal(out.armed, false); assert.deepEqual(out.armedTargetIds, []);
    assert.equal(out.preflightFailures[0].reason, "CONSERVATIVE_NET_NONPOSITIVE");
    assert.equal(out.preflightFailures[0].netEstimate.netLowerBoundProfitTokenRaw, (-loss).toString());
    assert.equal(f.counters.signed, 0); assert.equal(f.counters.nonce, 0); assert.equal(f.counters.sent, 0);
  }
});

test("held WETH plan still has a strictly positive-only conditional net test, not assumed profit", async t => {
  const f = await fixture(t, { fired: 1 });
  for (const loss of [0n, 1n]) {
    const policy = makeBatch().economics; policy.additionalReserveWethRaw = (1830000000000000n + loss).toString();
    const estimate = await near.estimateNetLowerBound(f.pinned, near.NEAR_TARGET_PLANS[1], { gasLimit: 600000n, maxFeePerGas: 250000000n }, policy);
    assert.equal(estimate.positive, false); assert.equal(estimate.netLowerBoundProfitTokenRaw, (-loss).toString());
  }
  assert.equal(f.counters.nonce, 0); assert.equal(f.counters.signed, 0); assert.equal(f.counters.sent, 0);
});

test("missing economic terms reject execution before any simulation/signing", async t => {
  const f = await fixture(t); delete f.batch.economics;
  await assert.rejects(f.run(), /BATCH_ECONOMICS_REQUIRED/);
  assert.equal(f.counters.estimated, 0); assert.equal(f.counters.signed, 0);
});

test("stale, nonpositive, incomplete, future, malformed and incorrectly denominated oracle evidence blocks execution", async t => {
  const invalid = [
    [{ answer: 0n }, "ORACLE_PRICE_NONPOSITIVE"], [{ answer: -1n }, "ORACLE_PRICE_NONPOSITIVE"],
    [{ startedAt: PIN_TIME - 61, updatedAt: PIN_TIME - 61 }, "ORACLE_STALE"],
    [{ answeredInRound: 6n }, "ORACLE_ROUND_INCOMPLETE"], [{ roundId: 0n }, "ORACLE_ROUND_INCOMPLETE"],
    [{ startedAt: 0 }, "ORACLE_ROUND_INCOMPLETE"], [{ updatedAt: 0 }, "ORACLE_ROUND_INCOMPLETE"],
    [{ startedAt: PIN_TIME - 10, updatedAt: PIN_TIME - 11 }, "ORACLE_ROUND_INCOMPLETE"],
    [{ startedAt: PIN_TIME + 1, updatedAt: PIN_TIME + 1 }, "ORACLE_FUTURE_TIMESTAMP"],
    [{ updatedAt: PIN_TIME + 1 }, "ORACLE_FUTURE_TIMESTAMP"], [{ decimals: 18 }, "ORACLE_DECIMALS_MISMATCH"],
    [{ description: "ETH / USDC" }, "ORACLE_DENOMINATION_MISMATCH"], [{ malformed: "latestRoundData" }, "ORACLE_ABI_INVALID"]
  ];
  for (const asset of ["eth", "usdc"]) for (const [override, reason] of invalid) {
    const f = await fixture(t, { [asset]: override }), out = await f.run();
    assert.equal(out.preflightFailures[0].reason, reason, `${asset}: ${reason}`);
    assert.equal(f.counters.signed, 0); assert.equal(f.counters.nonce, 0);
  }
  const unavailable = await fixture(t, { oracleUnavailable: true });
  assert.equal((await unavailable.run()).preflightFailures[0].reason, "CALL_REVERTED");
  assert.equal(unavailable.counters.signed, 0);
});

test("oracle freshness uses the pin timestamp, accepts the exact age boundary, and rejects provider disagreement", async t => {
  const f = await fixture(t, { eth: { startedAt: PIN_TIME - 60, updatedAt: PIN_TIME - 60 } });
  assert.equal((await f.run()).execution.intent.netEstimate.prices.ethUsd.ageAtPinSeconds, "60");
  const divergent = await fixture(t, { disagree: true });
  await assert.rejects(divergent.run(), /PIN_EVIDENCE_INVALIDATED/);
  assert.equal(divergent.counters.signed, 0); assert.equal(divergent.counters.sent, 0);
});

test("integer unit conversion rounds costs UP (including sub-unit gas and haircut) and negative reported value DOWN", async t => {
  const f = await fixture(t, { eth: { decimals: 0, answer: 3n }, usdc: { decimals: 0, answer: 2n } });
  const policy = makeBatch().economics;
  policy.ethUsdFeed.decimals = policy.usdcUsdFeed.decimals = 0;
  policy.additionalReserveUsdcRaw = "0"; policy.profitHaircutBps = "1";
  const estimate = await near.estimateNetLowerBound(f.pinned, { ...near.NEAR_TARGET_PLANS[0], minProfit: 1n }, { gasLimit: 1n, maxFeePerGas: 1n }, policy);
  assert.equal(estimate.gasCostProfitTokenRaw, "1"); assert.equal(estimate.profitHaircutRaw, "1");
  assert.equal(estimate.netLowerBoundProfitTokenRaw, "-1"); assert.equal(estimate.netLowerBoundNativeWei, "-666666666667");
  assert.equal(estimate.netLowerBoundUsdE8, "-200");
  // Exact division: 0.000002 ETH * 3 USD/ETH / 2 USD/USDC = 3 micro-USDC, not 4.
  policy.profitHaircutBps = "0";
  const exact = await near.estimateNetLowerBound(f.pinned, near.NEAR_TARGET_PLANS[0], { gasLimit: 1n, maxFeePerGas: 2000000000000n }, policy);
  assert.equal(exact.gasCostProfitTokenRaw, "3");
});

test("USDC is not USD, feed decimal scales differ, and priority/flash/swap costs are not double-counted", async t => {
  const f = await fixture(t, { eth: { decimals: 18, answer: 3000n * 10n ** 18n }, usdc: { decimals: 6, answer: 500000n } });
  const policy = makeBatch().economics; policy.ethUsdFeed.decimals = 18; policy.usdcUsdFeed.decimals = 6;
  policy.additionalReserveUsdcRaw = "7"; policy.profitHaircutBps = "1";
  const estimate = await near.estimateNetLowerBound(f.pinned, near.NEAR_TARGET_PLANS[2], { gasLimit: 1000000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 50000000n }, policy);
  assert.equal(estimate.nativeGasBudgetWei, "1000000000000000"); assert.equal(estimate.gasCostProfitTokenRaw, "6000000");
  assert.equal(estimate.profitHaircutRaw, "2000"); assert.equal(estimate.additionalReserveRaw, "7");
  assert.equal(estimate.netLowerBoundProfitTokenRaw, "13997993"); assert.equal(estimate.netLowerBoundUsdE8, "699899650");
  assert.equal(estimate.contractEnforcedProfitFloorRaw, "20000000");
});

test("WETH gas is exactly 1:1 ETH with integer precision above Number.MAX_SAFE_INTEGER and no USDC price dependency", async t => {
  const f = await fixture(t, { fired: 1, usdc: { answer: 0n } }), policy = makeBatch().economics;
  policy.profitHaircutBps = "0"; policy.additionalReserveWethRaw = "0";
  const floor = 900719925474099312345n;
  const estimate = await near.estimateNetLowerBound(f.pinned, { ...near.NEAR_TARGET_PLANS[1], minProfit: floor }, { gasLimit: 1n, maxFeePerGas: 1n }, policy);
  assert.equal(estimate.netLowerBoundProfitTokenRaw, (floor - 1n).toString());
  assert.equal(estimate.netLowerBoundNativeWei, (floor - 1n).toString());
  assert.equal(estimate.gasCostProfitTokenRaw, "1"); assert.equal(estimate.prices.usdcUsd, undefined);
  assert.equal(f.calls.some(c => c.method === "eth_call" && c.params[0].to === USDC_FEED), false);
});

test("economics/approval/expiry and pin freshness are revalidated under the wallet guard before signing", async t => {
  for (const change of ["economics", "approval", "expiry", "pin"]) {
    let time = NOW;
    const f = await fixture(t, { now: () => time });
    const nonce = f.pinned.nonce;
    f.pinned.nonce = async (...args) => {
      const result = await nonce(...args);
      if (change === "economics") f.batch.economics.additionalReserveUsdcRaw = "50001";
      if (change === "approval") f.batch.approved = false;
      if (change === "expiry") f.batch.expiresAt = new Date(NOW).toISOString();
      if (change === "pin") time += 121000;
      return result;
    };
    await assert.rejects(f.run({ loadBatch: () => f.batch }), change === "economics" ? /BATCH_ECONOMICS_CHANGED/ : change === "pin" ? /PIN_STALE_OR_FUTURE/ : /BATCH_INVALID_OR_EXPIRED/);
    assert.equal(f.counters.signed, 0); assert.equal(f.counters.sent, 0);
  }
});

for (const phase of ["pre-sign", "pre-send"]) {
  for (const [change, code, mutate] of [
    ["approval revoked", "BATCH_INVALID_OR_EXPIRED", b => { b.approved = false; }],
    ["target withdrawn", "BATCH_TARGET_NOT_APPROVED", b => { b.targets.shift(); }],
    ["wrong borrower", "BATCH_ACTION_NOT_APPROVED", b => { b.actions[0].borrower = OWNER; }],
    ["action permission withdrawn", "BATCH_ACTION_NOT_APPROVED", b => { b.actions[0].permission = "DO_NOT_EXECUTE"; }],
    ["economics changed", "BATCH_ECONOMICS_CHANGED", b => { b.economics.additionalReserveUsdcRaw = "50001"; }],
    ["economics missing", "BATCH_ECONOMICS_REQUIRED", b => { delete b.economics; }],
    ["gas cap tightened", "TX_CAP_EXCEEDED", b => { b.caps.maxExecuteGasLimit = 599999; }],
    ["fee cap tightened", "TX_CAP_EXCEEDED", b => { b.caps.maxFeePerGasWei = "249999999"; }],
    ["spend cap tightened", "TX_CAP_EXCEEDED", b => { b.caps.maxNativeSpendPerTransactionWei = "149999999999999"; }],
    ["daily cap tightened", "DAILY_EXECUTION_CAP_REACHED", b => { b.caps.signedExecutionsPerDay = 1; }],
    ["expiry passed", "BATCH_INVALID_OR_EXPIRED", (_b, advance) => advance()]
  ]) {
    test(`${change} during final ${phase} pin recheck blocks ${phase === "pre-sign" ? "signing and submission" : "submission"}`, async t => {
      let time = NOW, mutations = 0, freshLoads = 0;
      const f = await fixture(t, { now: () => time });
      if (change === "expiry passed") f.batch.expiresAt = new Date(NOW + 1000).toISOString();
      if (change === "daily cap tightened") guard.atomicJson(path.join(f.executionOptions.journalDir, "prior.json"), {
        stage: "RECEIPT_VERIFIED", txHash: hash(777), executedAt: new Date(NOW - 1000).toISOString()
      });
      const recheck = f.pinned.recheck;
      f.pinned.recheck = async () => {
        await recheck();
        // A durable unsigned/signed PREPARED intent identifies the exact guard phase, not a fragile call count.
        const prepared = guard.readJournals(f.executionOptions.journalDir).find(({ record }) => record.stage === "PREPARED")?.record;
        const atPhase = prepared && (phase === "pre-sign"
          ? f.counters.signed === 0 && prepared.txHash === null
          : f.counters.signed === 1 && prepared.txHash !== null);
        if (atPhase && mutations === 0) {
          mutate(f.batch, () => { time += 1000; });
          mutations++;
          // The mutation happens before this awaited wrapper resolves; the pin is still only 12–13 seconds old.
          assert.ok(time - f.pinned.pin.timestamp * 1000 <= 13000);
        }
      };
      await assert.rejects(f.run({ loadBatch: () => { if (mutations) freshLoads++; return f.batch; } }), {
        code: phase === "pre-sign" ? code : "BROADCAST_OUTCOME_UNCERTAIN"
      });
      assert.equal(mutations, 1); assert.equal(freshLoads, 1);
      assert.equal(f.counters.signed, phase === "pre-sign" ? 0 : 1);
      assert.equal(f.counters.sent, 0);
      const intent = guard.readJournals(f.executionOptions.journalDir).find(({ record }) => record.intent)?.record;
      assert.equal(intent.stage, phase === "pre-sign" ? "PREPARED" : "UNCERTAIN");
      assert.equal(intent.txHash, phase === "pre-sign" ? null : keccak256("0x010203"));
    });
  }
}

test("shared locks and indefinite pending reconciliation still block the trio before signing", async t => {
  const locked = await fixture(t), lock = guard.acquireWalletLock(locked.executionOptions);
  try { await assert.rejects(locked.run(), /WALLET_LOCK_HELD/); } finally { lock.release(); }
  assert.equal(locked.counters.signed, 0);
  const pending = await fixture(t, { pendingReceipt: true });
  guard.atomicJson(path.join(pending.executionOptions.journalDir, "old.json"), { stage: "SENT", txHash: hash(555), executedAt: "2000-01-01T00:00:00Z" });
  await assert.rejects(pending.run(), /TX_ALREADY_PENDING_ON_SAME_WALLET/);
  assert.equal(pending.counters.estimated, 0); assert.equal(pending.counters.nonce, 0); assert.equal(pending.counters.signed, 0);
});

test("no-return execution cannot fabricate simulated profit and any rank2 return remains insufficient to release its hold", async t => {
  const unified = await fixture(t, { unifiedResult: hash(5000000) });
  assert.equal((await unified.run()).preflightFailures.length, 1); assert.equal(unified.counters.signed, 0);
  for (const simulatedProfit of [1999999999999999n, 3305017393387660n, (1n << 256n) - 1n]) {
    const dedicated = await fixture(t, { fired: 1, simulatedProfit });
    assert.equal((await dedicated.run()).reason, "SLIPPAGE_PREFLIGHT_HOLD");
    assert.equal(dedicated.counters.signed, 0); assert.equal(dedicated.counters.estimated, 0);
  }
});

const RANK2_ID = "rank2_wsteth_weth_0x4cd7", ALL_IDS = near.NEAR_TARGET_PLANS.map(t => t.id);
async function rank2Fixture(t, options = {}) {
  const base = await fixture(t, { fired: options.fired ?? 1, now: options.now });
  const trace = await fixture(t, { fired: options.healthy ? -1 : 1, now: options.now, receiptTo: near.DEDICATED_V4_LIQUIDATOR });
  const session = { ...trace.pinned, evidence: { ...trace.pinned.evidence, traceQualified: true }, trace: async () => assert.fail("Preparation is explicitly stubbed in wiring unit tests") };
  const helper = require("../lib/aave-v4-near-swap-preflight.js");
  let opens = 0, preparations = 0, prepared;
  t.mock.method(helper, "prepareRank2SwapPreflight", async args => {
    preparations++; assert.equal(args.pinned, session); assert.equal(args.batch, base.batch); assert.equal(args.loadBatch(), base.batch);
    if (options.reject) throw new guard.ExecutionError("TRACE_DISCOVERY_FINAL_MISMATCH");
    if (options.status) return { status: options.status };
    const built = helper.buildRank2SwapTransaction({ S: 300000000000000000n, Q: 405000000000000001n, maxSlippageBps: 50,
      deadline: BigInt(Math.floor(args.now() / 1000) + (options.deadlineSeconds ?? 120)) });
    prepared = { status: "SIMULATION_ONLY", finalTx: built.transaction, finalCalldataHash: keccak256(built.transaction.data),
      deadline: built.deadline, fees: { gasLimit: "600000", maxFeePerGas: "250000000", maxPriorityFeePerGas: "50000000" },
      netEstimate: await near.estimateNetLowerBound(session, near.NEAR_TARGET_PLANS[1], { gasLimit: 600000n, maxFeePerGas: 250000000n }, base.batch.economics),
      Q: built.Q, M: built.M, policy: { batchId: base.batch.batchId }, evidence: { discovery: { C: built.S }, callProfitRaw: "5000000000000001" } };
    options.prepared?.(prepared, base.batch); return prepared;
  });
  const create = async () => { opens++; if (options.qualificationError) throw new guard.ExecutionError("TRACE_QUALIFIED_PAIR_REQUIRED"); return session; };
  return { base, trace, session, get opens() { return opens; }, get preparations() { return preparations; }, get prepared() { return prepared; },
    run(extra = {}) { return base.run({ createRank2Pinned: create, ...extra }); } };
}

test("trace-capable healthy polls enable all three targets without creating a trace session or preparing a swap", async t => {
  const f = await rank2Fixture(t, { fired: -1 }), out = await f.run();
  assert.equal(f.opens, 0); assert.equal(f.preparations, 0); assert.equal(out.armed, true);
  assert.deepEqual(out.enabledTargetIds, ALL_IDS); assert.deepEqual(out.armedTargetIds, ALL_IDS); assert.deepEqual(out.heldTargets, []);
  assert.ok(out.targets.every(row => row.readinessStatus === "READY_FOR_TRIGGER_PREFLIGHT"));
  assert.equal(f.base.counters.signed, 0); assert.equal(f.trace.counters.nonce, 0);
  const invalid = makeBatch(); delete invalid.economics;
  const blocked = await f.run({ execute: false, batch: invalid });
  assert.ok(blocked.targets.every(row => row.readinessStatus === "BLOCKED_POLICY")); assert.deepEqual(blocked.heldTargets, []); assert.equal(f.opens, 0);
});

test("triggered rank2 rechecks health and sends exactly the prepared calldata/fees on its trace-qualified session", async t => {
  const f = await rank2Fixture(t), out = await f.run(), prepared = f.prepared;
  assert.equal(f.opens, 1); assert.equal(f.preparations, 1); assert.equal(out.execution.intent.targetId, RANK2_ID); assert.equal(out.execution.stage, "RECEIPT_VERIFIED");
  assert.equal(f.base.signedTransactions[0].data, prepared.finalTx.data); assert.equal(out.execution.intent.calldataHash, prepared.finalCalldataHash);
  assert.equal(f.base.signedTransactions[0].gasLimit, 600000n); assert.equal(f.base.signedTransactions[0].maxFeePerGas, 250000000n);
  assert.equal(f.base.signedTransactions[0].maxPriorityFeePerGas, 50000000n);
  assert.deepEqual(out.execution.intent.simulation, { kind: "TRACE_AND_CALL_AUTHENTICATED_SWAP_PREFLIGHT", seizedCollateralRaw: prepared.evidence.discovery.C,
    quoteOutputWethRaw: prepared.Q, minSwapOutWethRaw: prepared.M, simulatedProfitBeforeGasRaw: prepared.evidence.callProfitRaw,
    deadline: prepared.deadline, finalCalldataHash: prepared.finalCalldataHash });
  assert.equal(f.base.counters.nonce, 0); assert.equal(f.base.counters.sent, 0); assert.equal(f.trace.counters.nonce, 2); assert.equal(f.trace.counters.sent, 1);
  assert.ok(f.trace.calls.some(c => c.method === "eth_getTransactionReceipt"));
  assert.equal(f.trace.calls.filter(c => c.method === "eth_call" && c.params[0].to === MULTICALL3 && c.params[0].data !== PROBE.encodeFunctionData("getBlockNumber")).length, 2);
  assert.deepEqual(out.enabledTargetIds, ALL_IDS); assert.deepEqual(out.heldTargets, []); assert.deepEqual(out.heldTriggers, []);
});

test("an already trace-qualified polling session is reused, and check-only never requests nonce/sign/send", async t => {
  const f = await rank2Fixture(t);
  const out = await f.run({ pinned: f.session, execute: false });
  assert.equal(f.opens, 0); assert.equal(f.preparations, 1); assert.equal(out.reason, "CHECK_ONLY_NO_SIGNING");
  assert.deepEqual(out.enabledTargetIds, ALL_IDS); assert.deepEqual(out.armedTargetIds, []);
  assert.equal(f.base.counters.signed, 0); assert.equal(f.trace.counters.nonce, 0); assert.equal(f.trace.counters.sent, 0);
  assert.equal(fs.existsSync(f.base.executionOptions.journalDir), false);
});

test("rank2 health/qualification/preparation failures hold only that trigger and leave rank5 executable", async t => {
  for (const [name, options, reason] of [["healthy at trace pin", { healthy: true }, "RANK2_NOT_LIQUIDATABLE"],
    ["qualification throws", { qualificationError: true }, "TRACE_QUALIFIED_PAIR_REQUIRED"], ["preparation rejects", { reject: true }, "TRACE_DISCOVERY_FINAL_MISMATCH"],
    ["non-simulation result", { status: "NOT_LIQUIDATABLE" }, "RANK2_SWAP_PREFLIGHT_NOT_READY"],
    ["hash mismatch", { prepared: p => { p.finalCalldataHash = hash(1); } }, "FINAL_CALLDATA_MISMATCH"],
    ["batch mismatch", { prepared: p => { p.policy.batchId = "OTHER_SYNTHETIC_BATCH"; } }, "BATCH_ID_CHANGED"],
    ["missing batch binding", { prepared: p => { delete p.policy; } }, "BATCH_ID_CHANGED"]]) await t.test(name, async t => {
    const f = await rank2Fixture(t, { ...options, fired: [1, 2] }), out = await f.run();
    assert.deepEqual(out.preflightFailures, [{ targetId: RANK2_ID, reason }]); assert.deepEqual(out.heldTriggers, HELD_TARGETS);
    assert.equal(out.execution.intent.targetId, ENABLED_IDS[1]); assert.equal(f.base.counters.signed, 1); assert.equal(f.base.counters.sent, 1);
    assert.equal(f.trace.counters.nonce, 0); assert.equal(f.trace.counters.sent, 0);
    assert.equal(f.preparations, options.healthy || options.qualificationError ? 0 : 1);
  });
  for (const operation of ["call", "recheck"]) await t.test(`${operation} throws`, async t => {
    const f = await rank2Fixture(t, { fired: [1, 2] }); f.session[operation] = async () => { throw new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED"); };
    const out = await f.run(); assert.equal(out.execution.intent.targetId, ENABLED_IDS[1]); assert.equal(out.preflightFailures[0].reason, "PIN_EVIDENCE_INVALIDATED");
    assert.equal(f.preparations, 0); assert.equal(f.trace.counters.sent, 0);
  });
});

test("failed rank2-only preflight is nonfatal and returns a target-specific hold while keeping rank1/rank5 armed", async t => {
  const f = await rank2Fixture(t, { reject: true }), out = await f.run();
  assert.equal(out.reason, "SLIPPAGE_PREFLIGHT_HOLD"); assert.equal(out.netEvaluation, "SLIPPAGE_PREFLIGHT_HOLD");
  assert.equal(out.armed, true); assert.deepEqual(out.armedTargetIds, ENABLED_IDS); assert.equal(out.execution, undefined);
  assert.deepEqual(out.heldTargets, HELD_TARGETS); assert.deepEqual(out.heldTriggers, HELD_TARGETS);
  assert.equal(f.base.counters.signed, 0); assert.equal(f.trace.counters.nonce, 0);
});

test("slippage/deadline/batch/economics revalidation before an intent blocks rank2 signing and permits rank5 unless economics changed", async t => {
  for (const when of ["before nonce", "after nonce"]) for (const change of ["slippage", "deadline", "batchId", "economics"]) await t.test(`${when}/${change}`, async t => {
    let time = NOW, mutations = 0;
    const f = await rank2Fixture(t, { fired: [1, 2], now: () => time, deadlineSeconds: 1 });
    const mutate = () => {
      if (mutations++) return;
      if (change === "slippage") f.base.batch.caps.maxSwapSlippageBps = f.base.batch.actions[1].slippage.maxSlippageBps = 49;
      if (change === "deadline") time += 2000;
      if (change === "batchId") f.base.batch.batchId = "REPLACED_SYNTHETIC_BATCH";
      // The original economics remain binding for every target in this pass.
      if (change === "economics") f.base.batch.economics.additionalReserveWethRaw = "10000000000001";
    };
    if (when === "before nonce") {
      const recheck = f.session.recheck; f.session.recheck = async () => { await recheck(); if (f.prepared) mutate(); };
    } else {
      const nonce = f.session.nonce; f.session.nonce = async (...args) => { const n = await nonce(...args); mutate(); return n; };
    }
    // Slippage and time are target-local. A changed economics policy correctly
    // prevents all signing under the original caps; it must not be silently adopted.
    if (change === "economics") {
      await assert.rejects(f.run(), { code: "BATCH_ECONOMICS_CHANGED" }); assert.equal(f.base.counters.signed, 0);
    } else {
      const out = await f.run(); assert.equal(out.execution.intent.targetId, ENABLED_IDS[1]); assert.equal(f.base.counters.signed, 1);
      assert.equal(out.preflightFailures[0].reason, { slippage: "SLIPPAGE_CAP_TIGHTENED", deadline: "SWAP_DEADLINE_EXPIRED", batchId: "BATCH_ID_CHANGED" }[change]);
      assert.deepEqual(out.heldTriggers, HELD_TARGETS);
    }
    assert.equal(f.trace.counters.sent, 0);
  });
});

test("late rank2 pre-sign/pre-send changes remain fail-closed and preserve pending journals instead of bypassing them for rank5", async t => {
  for (const phase of ["pre-sign", "pre-send"]) for (const change of ["slippage", "deadline", "batchId", "economics", "calldata"]) await t.test(`${phase}/${change}`, async t => {
    let time = NOW, changed = false, transaction;
    const f = await rank2Fixture(t, { fired: [1, 2], now: () => time, deadlineSeconds: 1 }), recheck = f.session.recheck;
    const executeGuarded = guard.executeGuarded;
    t.mock.method(guard, "executeGuarded", args => executeGuarded({ ...args, prepare: async () => {
      const prepared = await args.prepare(); transaction = prepared.transaction; return prepared;
    } }));
    f.session.recheck = async () => {
      await recheck();
      const journal = guard.readJournals(f.base.executionOptions.journalDir).find(({ record }) => record.stage === "PREPARED")?.record;
      if (!changed && journal && (phase === "pre-sign" ? journal.txHash === null : journal.txHash !== null)) {
        changed = true;
        if (change === "slippage") f.base.batch.caps.maxSwapSlippageBps = f.base.batch.actions[1].slippage.maxSlippageBps = 49;
        if (change === "deadline") time += 2000;
        if (change === "batchId") f.base.batch.batchId = "REPLACED_SYNTHETIC_BATCH";
        if (change === "economics") f.base.batch.economics.additionalReserveWethRaw = "10000000000001";
        if (change === "calldata") transaction.data = "0x1234";
      }
    };
    const reason = { slippage: "SLIPPAGE_CAP_TIGHTENED", deadline: "SWAP_DEADLINE_EXPIRED", batchId: "BATCH_ID_CHANGED",
      economics: "BATCH_ECONOMICS_CHANGED", calldata: "FINAL_CALLDATA_MISMATCH" }[change];
    await assert.rejects(f.run(), { code: phase === "pre-send" ? "BROADCAST_OUTCOME_UNCERTAIN" : reason });
    assert.equal(changed, true); assert.equal(f.base.counters.signed, phase === "pre-sign" ? 0 : 1); assert.equal(f.trace.counters.sent, 0); assert.equal(f.base.counters.sent, 0);
    const journals = guard.readJournals(f.base.executionOptions.journalDir); assert.equal(journals.length, 1);
    assert.equal(journals[0].record.stage, phase === "pre-sign" ? "PREPARED" : "UNCERTAIN");
    if (change === "calldata") assert.equal(keccak256(f.prepared.finalTx.data), f.prepared.finalCalldataHash, "only the actual signing transaction was mutated");
  });
});

test("near poll interval defaults to the base for absent, invalid, or distant target evidence", () => {
  for (const status of [undefined, null, {}, { targets: {} }, { targets: [] },
    { targets: [null, undefined, {}, { bpsToLiquidation: null }, { bpsToLiquidation: undefined }] },
    { targets: [{ bpsToLiquidation: "unknown" }, { bpsToLiquidation: NaN }, { bpsToLiquidation: Infinity }, { bpsToLiquidation: "-Infinity" }] },
    { targets: [{ bpsToLiquidation: "5.0001" }, { bpsToLiquidation: "10.0000" }, { isLiquidatableBothProviders: "true" }] }]) {
    assert.equal(near.computeNearPollIntervalMs(status), 12000);
    assert.equal(near.computeNearPollIntervalMs(status, 17000), 17000);
  }
});

test("near poll interval accelerates at the inclusive five-bps boundary or a corroborated liquidation trigger", () => {
  for (const target of [{ bpsToLiquidation: 5 }, { bpsToLiquidation: "5.0000" }, { bpsToLiquidation: "2.40" },
    { bpsToLiquidation: 0 }, { bpsToLiquidation: "-0.01" }, { isLiquidatableBothProviders: true },
    { isLiquidatableBothProviders: true, bpsToLiquidation: "10.0000" }]) {
    const status = Object.freeze({ targets: Object.freeze([Object.freeze({ bpsToLiquidation: "10.0000" }), Object.freeze(target)]) });
    assert.equal(near.computeNearPollIntervalMs(status), 6000);
    assert.equal(near.computeNearPollIntervalMs(status, 17000), 6000);
    assert.equal(near.computeNearPollIntervalMs(status, 4000), 4000, "pure helper never increases the supplied base");
  }
});

test("near poll interval includes held rank2 and does not mutate its status", () => {
  const status = { armed: true, heldTargets: HELD_TARGETS, targets: [
    { id: ENABLED_IDS[0], bpsToLiquidation: "10.0000" },
    { id: RANK2_ID, bpsToLiquidation: "2.40", isLiquidatableBothProviders: false, readinessStatus: "SLIPPAGE_PREFLIGHT_HOLD" }
  ] }, before = structuredClone(status);
  assert.equal(near.computeNearPollIntervalMs(status), 6000); assert.deepEqual(status, before);
});

test("near poll interval returns zero only for a verified receipt with strictly true armed state", () => {
  assert.equal(near.computeNearPollIntervalMs({ execution: { stage: "RECEIPT_VERIFIED" }, armed: true }), 0);
  assert.equal(near.computeNearPollIntervalMs({ execution: { stage: "RECEIPT_VERIFIED" }, armed: true, targets: [{ bpsToLiquidation: 1 }] }, 17000), 0);
  for (const armed of [false, undefined, "true", 1]) {
    assert.equal(near.computeNearPollIntervalMs({ execution: { stage: "RECEIPT_VERIFIED" }, armed }), 12000);
  }
  for (const stage of ["PREPARED", "SENT", "UNCERTAIN", "REVERTED", undefined]) {
    assert.equal(near.computeNearPollIntervalMs({ execution: { stage }, armed: true }), 12000);
  }
});

test("main keeps polling rank1/rank5 after rank2 qualification/preflight/healthy rejection", async t => {
  const cases = ["qualification", "preflight", "NOT_LIQUIDATABLE", "healthy at trace pin"].map(failure => [failure, failure, [], [6000, 12000]]);
  cases.push(["explicit interval remains fixed", "qualification", ["--interval-ms=17000"], [17000, 17000]]);
  for (const [name, failure, intervalArgs, expectedWaits] of cases) await t.test(name, async () => {
  const vm = require("node:vm"), filename = require.resolve("../execute-aave-v4-near-liquidation.js"), module = { exports: {} };
  let runner, polls = 0, pollingReads = 0, traceHealthReads = 0, preparations = 0, traceOpens = 0, helperLoads = 0;
  const logs = [], errors = [], waits = [], fakeProcess = { argv: [], exitCode: undefined }, batch = makeBatch();
  const health = fired => runner.MULTICALL_IFACE.encodeFunctionResult("aggregate3", [runner.NEAR_TARGET_PLANS.map((_, i) => ({ success: true,
    returnData: runner.DEDICATED_IFACE.encodeFunctionResult("previewHealthFactor", [fired && i === 1 ? 999999000000000000n : 1001000000000000000n, fired && i === 1, 1n, 1n]) }))]);
  const polling = { pin: { number: PIN, hash: hash(PIN), timestamp: PIN_TIME, baseFeePerGas: "115000000" }, evidence: { independentFamilies: true },
    recheck: async () => {}, receipt: async () => assert.fail("No receipts"),
    call: async tx => { pollingReads++; assert.equal(tx.to, MULTICALL3);
      assert.equal(runner.MULTICALL_IFACE.decodeFunctionData("aggregate3", tx.data)[0].length, 3, "rank1 and rank5 remain in every poll");
      return health(polls === 1); } };
  const rank2Pinned = { ...polling, evidence: { traceQualified: true }, trace: async () => assert.fail("Injected helper only"),
    call: async tx => { traceHealthReads++; assert.equal(tx.to, MULTICALL3); return health(failure !== "healthy at trace pin"); } };
  const imports = { "node:fs": { readFileSync: () => JSON.stringify(batch) }, "node:path": path, "./node_modules/ethers": require("../node_modules/ethers"),
    "./lib/wallet-execution-guard.js": { ...guard, reconcileWallet: async () => {}, atomicJson: () => {}, signWithProcessKey: async () => assert.fail("No keys"),
      executeGuarded: async () => assert.fail("Rejected/healthy triggers never reach execution") },
    "./lib/executor-pinned-rpc.js": { MULTICALL3, loadRpcCandidates: () => [], httpRpc: () => assert.fail("No network"), createPinnedRpc: async options => {
      if (options.requireTrace) { traceOpens++; if (failure === "qualification") throw new guard.ExecutionError("TRACE_QUALIFIED_PAIR_REQUIRED"); return rank2Pinned; }
      if (++polls > 2) throw new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED"); return polling;
    } }, "./lib/aave-v4-near-swap-preflight.js": { prepareRank2SwapPreflight: async args => {
      preparations++; assert.equal(args.pinned, rank2Pinned);
      if (failure === "preflight") throw new guard.ExecutionError("TRACE_DISCOVERY_FINAL_MISMATCH");
      assert.equal(failure, "NOT_LIQUIDATABLE"); return { status: "NOT_LIQUIDATABLE" };
    }, minimumOutput: () => assert.fail("No quote") } };
  class Clock extends Date { static now() { return NOW; } }
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports, __dirname: path.dirname(filename), process: fakeProcess, Date: Clock,
    require(name) { if (name.includes("near-swap-preflight")) helperLoads++; assert.ok(Object.hasOwn(imports, name)); return imports[name]; },
    console: { log: text => logs.push(JSON.parse(text)), error: text => errors.push(JSON.parse(text)) }, setTimeout: (callback, ms) => { waits.push(ms); callback(); } });
  runner = module.exports; assert.equal(helperLoads, 0, "no top-level circular import");
  await runner.main(["--execute-if-liquidatable", "--loop", "--no-write", ...intervalArgs]);
  assert.equal(polls, 3); assert.equal(pollingReads, 2); assert.equal(traceOpens, 1); assert.equal(helperLoads, 1); assert.deepEqual(waits, expectedWaits);
  assert.equal(traceHealthReads, failure === "qualification" ? 0 : 1);
  assert.equal(preparations, ["preflight", "NOT_LIQUIDATABLE"].includes(failure) ? 1 : 0);
  assert.equal(logs[0].reason, "SLIPPAGE_PREFLIGHT_HOLD"); assert.equal(logs[0].armed, true);
  assert.deepEqual(logs[0].enabledTargetIds, ALL_IDS); assert.deepEqual(logs[0].armedTargetIds, ENABLED_IDS); assert.deepEqual(logs[0].heldTargets, HELD_TARGETS);
  assert.deepEqual(logs[0].heldTriggers, HELD_TARGETS); assert.equal(logs[0].preflightFailures[0].reason, {
    qualification: "TRACE_QUALIFIED_PAIR_REQUIRED", preflight: "TRACE_DISCOVERY_FINAL_MISMATCH", NOT_LIQUIDATABLE: "RANK2_SWAP_PREFLIGHT_NOT_READY",
    "healthy at trace pin": "RANK2_NOT_LIQUIDATABLE" }[failure]);
  assert.equal(logs[1].armed, true); assert.deepEqual(logs[1].armedTargetIds, ALL_IDS); assert.deepEqual(logs[1].heldTriggers, []);
  assert.equal(logs.length, 2);
  assert.equal(errors.at(-1).reason, "PIN_EVIDENCE_INVALIDATED");
  });
});
