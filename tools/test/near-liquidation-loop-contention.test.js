"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ethers = require("../node_modules/ethers"), guard = require("../lib/wallet-execution-guard.js");
const { MULTICALL3 } = require("../lib/executor-pinned-rpc.js");
const FILE = path.resolve(__dirname, "../execute-aave-v4-near-liquidation.js");
const SOURCE = fs.readFileSync(FILE, "utf8");
const NOW = Date.parse("2026-10-19T23:00:00Z");
const ETH_FEED = "0x" + "11".repeat(20), USDC_FEED = "0x" + "22".repeat(20);
const lock = () => new guard.ExecutionError("WALLET_LOCK_HELD");
const fatal = () => new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED");

// Entire main/runOnce source executes in the VM. Only dependencies/time/process
// are injected; no source replacement, live files, wallet locks or RPC access.
function harness(steps, { onWait } = {}) {
  const state = { time: NOW, passes: 0, reads: 0, reconciles: 0, guarded: 0, signed: 0, sent: 0, nonce: 0,
    candidates: 0, pinned: [], waits: [], writes: [], errors: [], logs: [], process: { argv: [], exitCode: undefined } };
  let near;
  const fakeGuard = {
    ...guard,
    atomicJson(file, value) {
      assert.equal(file, path.resolve(__dirname, "../../reports/raw/fast/aave-v4-near-liquidation-live-watch.json"));
      state.writes.push(JSON.parse(JSON.stringify(value)));
    },
    async reconcileWallet() {
      state.reconciles++;
      const step = steps[state.passes - 1];
      if (step.error) throw step.error;
    },
    async executeGuarded() {
      state.guarded++;
      assert.equal(steps[state.passes - 1].kind, "execution");
      return { stage: "RECEIPT_VERIFIED", realizedNetProfit: "UNKNOWN" };
    },
    async signWithProcessKey() { state.signed++; assert.fail("No signer or key access in loop tests"); }
  };
  const fakeRpc = {
    MULTICALL3,
    loadRpcCandidates() { state.candidates++; return [{ family: "test-a" }, { family: "test-b" }]; },
    httpRpc() { assert.fail("No network calls"); },
    async createPinnedRpc() {
      const step = steps[state.passes++]; assert.ok(step, "Unexpected extra pass/busy loop");
      const pinned = {
        pin: { number: 26229760 + state.passes, hash: "0x" + "ab".repeat(32), timestamp: state.time / 1000, baseFeePerGas: "115000000" },
        evidence: { independentFamilies: true },
        async recheck() {}, assertUsable() {},
        async call(tx) {
          if (tx.to === MULTICALL3) return near.MULTICALL_IFACE.encodeFunctionResult("aggregate3", [near.NEAR_TARGET_PLANS.map((_, index) => {
            const fired = index === 0 && ["preflight-blocked", "execution"].includes(step.kind);
            return { success: true, returnData: near.DEDICATED_IFACE.encodeFunctionResult("previewHealthFactor", [
              fired ? 999999000000000000n : 1001000000000000000n, fired, 1n, 1n
            ]) };
          })]);
          if (tx.to === near.UNIFIED_LIQUIDATOR) {
            if (step.kind === "preflight-blocked") throw new guard.ExecutionError("CALL_REVERTED");
            return "0x";
          }
          assert.ok([ETH_FEED, USDC_FEED].includes(tx.to));
          const name = near.FEED_IFACE.parseTransaction({ data: tx.data }).name;
          return near.FEED_IFACE.encodeFunctionResult(name, name === "decimals" ? [8]
            : name === "description" ? [tx.to === ETH_FEED ? "ETH / USD" : "USDC / USD"]
              : [1, tx.to === ETH_FEED ? 240000000000n : 100000000n, pinned.pin.timestamp - 1, pinned.pin.timestamp - 1, 1]);
        },
        async estimateGas() { return 500000n; },
        async nonce() { state.nonce++; assert.fail("No nonce for mocked guarded execution"); },
        async send() { state.sent++; assert.fail("No submission in loop tests"); },
        async receipt() { assert.fail("No receipt access in loop tests"); }
      };
      state.pinned.push(pinned); return pinned;
    }
  };
  const fakeFs = {
    readFileSync(file, encoding) {
      assert.equal(file, path.resolve(__dirname, "../../coordination/live-execution-batch-aave-v4-near-liquidation-20261019.json"));
      assert.equal(encoding, "utf8"); state.reads++; return JSON.stringify(state.batch);
    }
  };
  const imports = { "node:fs": fakeFs, "node:path": path, "./node_modules/ethers": ethers,
    "./lib/wallet-execution-guard.js": fakeGuard, "./lib/executor-pinned-rpc.js": fakeRpc };
  const module = { exports: {} };
  class Clock extends Date { static now() { return state.time; } }
  vm.runInNewContext(SOURCE, {
    require(name) { assert.ok(Object.hasOwn(imports, name), "Unexpected import: " + name); return imports[name]; },
    module, __dirname: path.dirname(FILE), process: state.process, Date: Clock,
    console: { log(text) { state.logs.push(JSON.parse(text)); }, error(text) { state.errors.push(JSON.parse(text)); } },
    setTimeout(callback, interval) {
      state.waits.push({ interval, pass: state.passes, exitCode: state.process.exitCode, status: structuredClone(state.writes.at(-1)) });
      state.time += interval; onWait?.(state); callback();
    }
  }, { filename: FILE });
  near = module.exports;
  state.batch = {
    schema: "live-execution-batch/v1", batchId: "OFFLINE_LOOP_TEST", approved: true, expiresAt: "2026-10-26T23:59:59Z",
    chain: "ethereum", chainId: 1, account: { address: guard.MAIN_ACCOUNT }, targets: near.REQUIRED_TARGETS.map(address => ({ address })),
    actions: near.NEAR_TARGET_PLANS.map(p => ({ targetId: p.id, permission: "EXECUTE_ON_TRIGGER", method: p.executorKind === "UNIFIED" ? "executeMorpho" : "execute",
      executor: p.executor, spoke: p.spoke, borrower: p.borrower, collateralAsset: p.collateralAsset, debtAsset: p.debtAsset,
      ...Object.fromEntries(["collateralReserveId", "debtReserveId", "flashLoanAmount", "debtToCover", "minProfit"].map(k => [k, p[k].toString()])),
      slippage: p.executorKind === "UNIFIED" ? { mode: "NO_SWAP_SAME_ASSET", minSwapOutRaw: "0" }
        : { mode: "QUOTE_RELATIVE", maxSlippageBps: 50, minSwapOutRaw: p.minSwapOut.toString() } })),
    caps: { valueCapEth: "0", principalAtRisk: "zero (atomic synthetic test)", maxExecuteGasLimit: 1200000, maxFeePerGasWei: "250000000",
      maxNativeSpendPerTransactionWei: "300000000000000", signedExecutionsPerDay: 3, maxSwapSlippageBps: 50,
      minProfitUsdcRaw: "5000000", minProfitWethRaw: "2000000000000000" },
    economics: { schema: "near-liquidation-economics/v1", additionalReserveUsdcRaw: "2000000", additionalReserveWethRaw: "500000000000000", profitHaircutBps: "1000",
      ethUsdFeed: { address: ETH_FEED, decimals: 8, maxAgeSeconds: 3600 }, usdcUsdFeed: { address: USDC_FEED, decimals: 8, maxAgeSeconds: 82800 } }
  };
  state.run = (argv = ["--execute-if-liquidatable", "--loop", "--interval-ms=17000"]) => near.main(argv);
  return state;
}
function noSigning(state) {
  assert.equal(state.signed, 0); assert.equal(state.sent, 0); assert.equal(state.nonce, 0);
}

test("initial contention preserves blocked telemetry, waits normally and obtains a fresh healthy pass", async () => {
  const s = harness([{ error: lock() }, { kind: "healthy" }, { error: fatal() }]);
  await s.run();
  assert.equal(s.passes, 3); assert.equal(s.candidates, 3); assert.equal(s.reconciles, 3); assert.equal(s.reads, 4);
  assert.equal(new Set(s.pinned).size, 3);
  assert.deepEqual(s.waits.map(w => w.interval), [17000, 17000]);
  assert.ok(s.waits.every(w => w.exitCode === undefined));
  assert.equal(s.waits[0].status.mode, "BLOCKED"); assert.equal(s.waits[0].status.armed, false);
  assert.equal(s.waits[0].status.reason, "WALLET_LOCK_HELD");
  assert.equal(s.logs.length, 1); assert.equal(s.logs[0].armed, true); assert.equal(s.logs[0].firedCount, 0);
  assert.deepEqual(s.logs[0].heldTargets, []); assert.equal(s.logs[0].armedTargetIds.length, 3);
  assert.deepEqual(s.errors, [{ ok: false, reason: "WALLET_LOCK_HELD" }, { ok: false, reason: "PIN_EVIDENCE_INVALIDATED" }]);
  assert.equal(s.process.exitCode, 1); assert.equal(s.guarded, 0); noSigning(s);
});

test("subsequent contention after a healthy pass also waits without signing or clearing the lock", async () => {
  const s = harness([{ kind: "healthy" }, { error: lock() }, { kind: "healthy" }, { error: fatal() }]);
  await s.run();
  assert.equal(s.logs.length, 2); assert.ok(s.logs.every(out => out.armed));
  assert.deepEqual(s.waits.map(w => w.interval), [17000, 17000, 17000]);
  assert.equal(s.waits[1].status.reason, "WALLET_LOCK_HELD"); assert.equal(s.waits[1].exitCode, undefined);
  assert.equal(s.passes, 4); assert.equal(s.guarded, 0); noSigning(s);
});

test("persistent locks remain blocked until an unrelated fatal error; no lock reclaim or busy loop", async () => {
  const held = lock(), s = harness([{ error: held }, { error: held }, { error: held }, { error: fatal() }]);
  await s.run();
  assert.equal(s.passes, 4); assert.equal(s.logs.length, 0); assert.equal(s.writes.length, 4);
  assert.deepEqual(s.waits.map(w => [w.interval, w.pass, w.exitCode]), [[17000, 1, undefined], [17000, 2, undefined], [17000, 3, undefined]]);
  assert.ok(s.waits.every(w => w.status.reason === "WALLET_LOCK_HELD" && w.status.armed === false));
  assert.equal(s.process.exitCode, 1); assert.equal(s.guarded, 0); noSigning(s);
});

test("one-shot lock contention remains fatal without a retry timer", async () => {
  const s = harness([{ error: lock() }]); await s.run(["--execute-if-liquidatable"]);
  assert.equal(s.process.exitCode, 1); assert.equal(s.passes, 1); assert.equal(s.waits.length, 0); noSigning(s);
});

test("all other errors, including untyped lookalike lock errors and pending journals, remain fatal", async () => {
  for (const error of [fatal(), new guard.ExecutionError("TX_ALREADY_PENDING_ON_SAME_WALLET"),
    new guard.ExecutionError("PREPARED_INTENT_REQUIRES_MANUAL_RECONCILIATION"), new guard.ExecutionError("JOURNAL_MALFORMED"),
    Object.assign(new Error("WALLET_LOCK_HELD"), { code: "WALLET_LOCK_HELD" }), { code: "WALLET_LOCK_HELD" }]) {
    const s = harness([{ error }]); await s.run();
    assert.equal(s.process.exitCode, 1); assert.equal(s.passes, 1); assert.equal(s.waits.length, 0);
    assert.equal(s.errors[0].reason, guard.safeError(error)); noSigning(s);
  }
});

test("approval revocation while waiting stops the next pass before RPC qualification or guard access", async () => {
  const s = harness([{ error: lock() }], { onWait(state) { state.batch.approved = false; } });
  await s.run();
  assert.equal(s.reads, 2); assert.equal(s.passes, 1); assert.equal(s.candidates, 1); assert.equal(s.reconciles, 1);
  assert.equal(s.waits.length, 1); assert.equal(s.waits[0].exitCode, undefined);
  assert.equal(s.errors.at(-1).reason, "BATCH_INVALID_OR_EXPIRED"); assert.equal(s.process.exitCode, 1); noSigning(s);
});

test("retry uses the unchanged default/minimum interval and never sleeps after a fatal error", async () => {
  for (const [args, interval] of [[[], 12000], [["--interval-ms=1"], 6000]]) {
    const s = harness([{ error: lock() }, { error: fatal() }]);
    await s.run(["--execute-if-liquidatable", "--loop", ...args]);
    assert.deepEqual(s.waits.map(w => w.interval), [interval]); noSigning(s);
  }
});

test("explicit unarmed preflight output still terminates the loop without retry or signing", async () => {
  const s = harness([{ kind: "preflight-blocked" }]); await s.run();
  assert.equal(s.logs[0].armed, false); assert.equal(s.logs[0].reason, "NO_FIRED_TARGET_PASSED_PREFLIGHT");
  assert.equal(s.waits.length, 0); assert.equal(s.errors.length, 0); assert.equal(s.process.exitCode, undefined); noSigning(s);
});

test("an execution result still terminates the loop even when the returned watch is armed", async () => {
  const s = harness([{ kind: "execution" }]); await s.run();
  assert.equal(s.guarded, 1); assert.equal(s.logs[0].execution.stage, "RECEIPT_VERIFIED"); assert.equal(s.logs[0].armed, true);
  assert.equal(s.waits.length, 0); assert.equal(s.errors.length, 0); assert.equal(s.process.exitCode, undefined); noSigning(s);
});
