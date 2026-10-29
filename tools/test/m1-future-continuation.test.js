"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const runner = require("../execute-top-whale-trigger.js"), transport = require("../lib/executor-pinned-rpc.js");
const watcher = require("../watch-top-whale-triggers.js"), m1 = require("../lib/m1-live-evidence.js"), guard = require("../lib/wallet-execution-guard.js");
const live = require("./m1-live-evidence.test.js"), { Interface } = require("../node_modules/ethers");
const { asyncHarness, deferred } = require("./m1-async-harness-fixture.js");
const FLAGS = ["--m1-only", "--m1-hot-path-v2", "--next-block", "--no-write", "--watch", "5", "--max-runs", "2"];
const NOW = Date.parse("2026-10-24T02:00:01Z"), TIME = NOW / 1000 - 1, HEAD = 1000;
const hex = n => "0x" + BigInt(n).toString(16), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0"), UNKNOWN = "0x" + "f".repeat(64);
const turn = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const forbidden = () => assert.fail("OFFLINE_FORBIDDEN_IO");
const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = forbidden; });
test.after(() => { globalThis.fetch = originalFetch; });
const closedRow = row => ({ ...row, inactive: true, positionStatus: "CLOSED", debtRaw: "0", currentDebtRaw: "0", liquidatableNow: false });

function controlled(t, options = {}) {
  const async = asyncHarness(t), f = live.fixture(async.fixtureContext), state = { mono: 0, acquisitions: 0, passes: 0, collections: [], outputs: [], takes: 0, cancels: 0,
    subscribed: 0, unsubscribed: 0, ready: false, taken: false, cancelled: false, wake: null, active: 0, peak: 0, headReads: 0, closes: 0 };
  const current = { ...f.pinned, evidence: { ...f.pinned.evidence, nextBlockQualified: false }, nextBlock: undefined };
  current.assertUsable = () => { if (state.invalid) throw new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED"); };
  const healthy = { ...f.row, inactive: false, positionStatus: "OPEN", debtReadStatus: "COMPLETE", debtRaw: "100",
    currentDebtRaw: "100", maxBorrowRaw: "101", nextBlockForecast: undefined };
  const lease = { current,
    isFutureReady() { return state.ready && !state.taken && !state.cancelled && !state.invalid; },
    onFutureReady(wake) { state.subscribed++; state.wake = wake; return () => { state.unsubscribed++; state.wake = null; }; },
    takeFuture() { state.takes++; if (!lease.isFutureReady()) { state.taken = true; return null; } state.taken = true; return f.pinned; },
    cancelFuture() { state.cancels++; state.cancelled = true; },
  };
  async.onCleanup(() => { if (!state.cancelled) lease.cancelFuture(); state.wake = null; });
  const notify = () => state.wake?.();
  const dependencies = {
    loadCandidates: () => [], loadBatch: () => live.batch(0), now: () => state.mono,
    wallNow: () => f.state.now + state.mono, monotonicNow: () => state.mono,
    connect: config => runner.connectForPass(config),
    createM1HotPathFactory: profile => {
      assert.equal(profile.allowFuture, !options.measureOnly);
      const factory = { maintain() {}, acquire: async () => { assert.equal(state.active, 0); state.acquisitions++; return lease; }, close() { state.closes++; lease.cancelFuture(); } };
      async.onCleanup(() => { if (!state.closes) factory.close(); });
      return factory;
    },
    runPass: async args => {
      state.passes++;
      return f.run({ ...args, execute: options.execute === true, pinned: current, hotPathLease: lease,
        checkOnce: async config => {
          assert.equal(config.writeOut, false); assert.equal(config.m1Only, true);
          const future = !!config.nextBlockContext; state.collections.push(future ? "FUTURE" : "CURRENT");
          state.peak = Math.max(state.peak, ++state.active);
          try {
            if (state.passes === 1 && !future) assert.equal(state.subscribed, options.measureOnly || options.maxRuns === 1 ? 0 : 1, "subscription precedes CURRENT collection");
            await options.onCollect?.({ state, future, config, f, lease });
            const row = state.passes > 1 ? closedRow(healthy) : future ? f.row : options.row?.(healthy, f) || healthy;
            return { pin: { ...current.pin, chainId: 1 }, targets: { [m1.ID]: row } };
          } finally { state.active--; }
        }, ...(options.passOptions || {}) });
    },
    liveHeadNumber: async () => { assert.equal(state.active, 0); state.headReads++;
      return options.head ? options.head({ state, f, lease, notify }) : state.outputs.some(row => row.passPhase === "FUTURE_CONTINUATION") ? current.pin.number + 1 : current.pin.number; },
    sleep: async ms => { state.mono += ms; await options.onSleep?.({ state, f, lease, notify, ms }); },
    output: summary => { state.outputs.push(summary); options.onOutput?.({ state, f, lease, notify, summary }); },
  };
  const argv = [...FLAGS, ...(options.measureOnly ? ["--measure-only"] : options.execute ? ["--execute"] : ["--check"])];
  if (options.maxRuns === 1) argv[argv.indexOf("--max-runs") + 1] = "1";
  return { f, state, lease, healthy, notify, dependencies, async, run: overrides => async.run(() => runner.main(argv, { ...dependencies, ...overrides })) };
}

test("idle owner consumes one same-lease continuation; readiness storms neither rerun CURRENT nor overlap acquisition", async t => {
  const f = controlled(t, { onSleep({ state, notify }) { state.ready = true; for (let i = 0; i < 100; i++) notify(); } });
  await f.run();
  assert.deepEqual(f.state.collections, ["CURRENT", "FUTURE", "CURRENT"]);
  assert.equal(f.state.takes, 1); assert.equal(f.state.acquisitions, 2); assert.equal(f.state.passes, 2); assert.equal(f.state.peak, 1);
  assert.equal(f.state.outputs.length, 3); assert.deepEqual(f.state.outputs.slice(0, 2).map(row => [row.run, row.passPhase]), [[1, "CURRENT"], [1, "FUTURE_CONTINUATION"]]);
  assert.equal(f.state.outputs[0].futureContinuation, "WAITING"); assert.equal(f.state.outputs[0].candidateCount, 0);
  assert.equal(f.state.outputs[1].candidateCount, 1); assert.equal(f.state.outputs[1].phaseTimingsMs.acquisition, null);
  assert.equal(f.state.outputs[1].m1Budget.detectionWallMs, f.state.outputs[0].m1Budget.detectionWallMs);
  assert.equal(f.state.outputs[1].m1Budget.detectionMonoMs, f.state.outputs[0].m1Budget.detectionMonoMs);
  assert.equal(f.state.unsubscribed, 1); assert.equal(f.state.closes, 1); assert.equal(f.f.state.signs, 0);
  assert.doesNotMatch(JSON.stringify(f.state.outputs), /resume|futureContinuationOwner|PRIVATE|OFFLINE_HANDLE/);
});

test("same-lease continuation retains the complete real M1 exact preparation/execution and one signed-attempt owner", async t => {
  const f = controlled(t, { execute: true, onSleep({ state, notify }) { state.ready = true; notify(); } });
  await f.run({ runPass: async args => {
    f.state.passes++;
    return f.f.run({ ...args, secondarySendRawTransaction: async () => {}, checkOnce: async config => {
      f.state.collections.push(config.nextBlockContext ? "FUTURE" : "CURRENT");
      return { pin: { ...f.lease.current.pin, chainId: 1 }, targets: { [m1.ID]: f.state.passes > 1 ? closedRow(f.healthy) : config.nextBlockContext ? f.f.row : f.healthy } };
    } });
  } });
  assert.equal(f.f.state.signs, 1); assert.equal(f.f.state.sends, 1); assert.equal(f.state.takes, 1);
  assert.deepEqual(f.state.collections, ["CURRENT", "FUTURE", "CURRENT"]);
  const result = f.state.outputs.find(row => row.passPhase === "FUTURE_CONTINUATION");
  assert.equal(result.execution.stage, "RECEIPT_VERIFIED"); assert.equal(result.execution.intent.targetId, m1.ID);
  assert.ok(result.execution.intent.m1LiveProof.transaction); assert.equal(result.execution.intent.measuredProfitRaw, null);
  assert.equal(result.m1Budget.detectionMonoMs, 0); assert.ok(result.m1Budget.fullUnsignedElapsedMs >= 300);
});

for (const kind of ["closed", "unknown", "inactive", "underwater", "missing-debt", "current", "admission-error", "collection-error"])
  test(`${kind} CURRENT cannot retain or trigger a continuation`, async t => {
    const f = controlled(t, {
      row: (healthy, liveCase) => ({ ...healthy, ...({ closed: { positionStatus: "CLOSED", debtRaw: "0" }, unknown: { positionStatus: "UNKNOWN" },
        inactive: { inactive: true }, underwater: { liquidatableNow: true }, "missing-debt": { currentDebtRaw: undefined },
        current: { liquidatableNow: true, readyExecuteMorphoBlueCalldata: live.calldata() },
        "admission-error": { liquidatableNow: true, readyExecuteMorphoBlueCalldata: "0x1234" } }[kind] || {}) }),
      onCollect({ future }) { if (kind === "collection-error" && !future) throw new guard.ExecutionError("COLLECTOR_PIN_MISMATCH"); },
      onSleep({ state, notify }) { assert.equal(state.cancelled, true); state.ready = true; notify(); },
      head: ({ state, lease }) => { assert.equal(state.cancelled, true); return lease.current.pin.number + 1; },
    });
    await f.run(); assert.deepEqual(f.state.collections, ["CURRENT", "CURRENT"]); assert.equal(f.state.takes, 0);
    assert.equal(f.state.outputs.some(row => row.passPhase === "FUTURE_CONTINUATION"), false); assert.equal(f.state.unsubscribed, 1);
  });

test("nonstrict healthy CURRENT fails continuation admission and cancels without optional nonce or preparation", async t => {
  const f = controlled(t, { head: ({ lease }) => lease.current.pin.number + 1 });
  f.lease.current.evidence.strictEvidence = false;
  await f.run(); assert.equal(f.state.outputs[0].preflightFailures[0].reason, "M1_STRICT_EVIDENCE_REQUIRED");
  assert.equal(f.state.takes, 0); assert.equal(f.f.state.nonces, 0); assert.equal(f.f.state.signs, 0);
});

test("already-ready watch child uses the ordinary path immediately, without a deferred handoff", async t => {
  const f = controlled(t, { onCollect({ state, future }) { if (!future) state.ready = true; }, head: ({ lease }) => lease.current.pin.number + 1 });
  await f.run(); assert.equal(f.state.takes, 1);
  assert.deepEqual(f.state.collections, ["CURRENT", "FUTURE", "CURRENT"]);
  assert.equal(f.state.outputs.length, 2); assert.equal(f.state.outputs[0].futureContinuation, undefined);
  assert.equal(f.state.outputs[0].candidateCount, 1); assert.equal(f.state.unsubscribed, 1);
});

for (const signed of [false, true]) test(`CURRENT preparation ${signed ? "signed-attempt" : "unsigned hold"} cancels before execution and never hands off`, async t => {
  let preparations = 0, signs = 0;
  const f = controlled(t, { execute: true, row: healthy => ({ ...healthy, liquidatableNow: true, readyExecuteMorphoBlueCalldata: live.calldata() }),
    passOptions: { signTransaction: async () => { signs++; throw new guard.ExecutionError("OFFLINE_SIGNER_FAILURE"); } },
    head: ({ lease }) => lease.current.pin.number + 1 });
  t.mock.method(m1, "executeM1", async args => {
    preparations++; assert.equal(f.state.cancelled, true);
    if (signed) await args.signTransaction({});
    throw new guard.ExecutionError("M1_NET_NONPOSITIVE");
  });
  await f.run(); assert.equal(preparations, 1); assert.equal(signs, signed ? 1 : 0); assert.equal(f.state.takes, 0);
  assert.deepEqual(f.state.collections, ["CURRENT", "CURRENT"]); assert.equal(f.state.outputs[0].futureContinuation, undefined);
  if (signed) assert.equal(f.state.outputs[0].reason, "SIGNED_ATTEMPT_ENDED_PASS");
});

for (const failure of ["expired", "timeout", "canonical"])
  test(`late ${failure} child fails once without forecast retry or a new CURRENT nomination`, async t => {
    const f = controlled(t, { onSleep({ state, f, notify }) {
      if (failure === "expired") f.state.now = f.context.timestamp * 1000;
      state.ready = true; notify();
    } });
    if (failure !== "expired") f.f.pinned.nextBlock.recheck = async () => { throw new guard.ExecutionError(failure === "timeout" ? "RPC_TIMEOUT" : "NEXT_BLOCK_CANONICAL_DISAGREEMENT"); };
    await f.run(); assert.equal(f.state.takes, failure === "expired" ? 0 : 1);
    assert.deepEqual(f.state.collections, failure === "expired" ? ["CURRENT"] : ["CURRENT", "CURRENT"]);
    if (failure === "expired") assert.equal(f.state.outputs.at(-1).reason, "M1_V2_CHILD_HEADROOM_INSUFFICIENT");
    assert.equal(f.state.outputs.filter(row => row.passPhase === "FUTURE_CONTINUATION").length, 1);
    assert.equal(f.f.state.signs, 0); assert.equal(f.state.cancelled, true);
  });

test("same-lease waiting counts against original detection even when continuation phase timings reset", async t => {
  const f = controlled(t, { execute: true,
    onCollect({ state, future }) { if (state.passes === 1 && !future) state.mono = 5800; },
    onSleep({ state, notify }) { state.ready = true; notify(); },
  });
  await f.run();
  const waiting = f.state.outputs[0], continued = f.state.outputs.find(row => row.passPhase === "FUTURE_CONTINUATION");
  assert.equal(waiting.futureContinuation, "WAITING"); assert.equal(continued.reason, "M1_V2_UNSIGNED_BUDGET_EXCEEDED");
  assert.equal(continued.m1Budget.detectionMonoMs, waiting.m1Budget.detectionMonoMs);
  assert.equal(continued.phaseTimingsMs.acquisition, null); assert.equal(continued.m1Budget.unsignedReadyMonoMs, null);
  assert.equal(f.state.takes, 0); assert.equal(f.f.state.signs, 0); assert.equal(f.f.state.sends, 0);
});

for (const race of ["head", "deadline", "trust", "cancel"])
  test(`${race} wins over idle readiness without extending the absolute CURRENT deadline`, async t => {
    const f = controlled(t, {
      onSleep({ state, lease, notify }) {
        if (race === "deadline") state.mono = 5001;
        if (race === "trust") state.invalid = true;
        if (race === "cancel") lease.cancelFuture();
        state.ready = true; notify();
      },
      head: ({ state, lease }) => state.headReads > 1 && race === "head" ? lease.current.pin.number + 1 : lease.current.pin.number,
    });
    const acquiredAt = [];
    await f.run({ connect: async config => { acquiredAt.push(f.state.mono); return runner.connectForPass(config); } });
    assert.equal(f.state.takes, 0); assert.equal(f.state.outputs.some(row => row.passPhase === "FUTURE_CONTINUATION"), false);
    assert.equal(acquiredAt.length, 2); assert.ok(acquiredAt[1] <= (race === "deadline" ? 5001 : 5000)); assert.equal(f.state.unsubscribed, 1);
  });

test("continuation execution cannot reset the existing idle deadline or run beside a new CURRENT acquisition", async t => {
  const async = asyncHarness(t), gate = async.gate(), entered = deferred(); let forecastActive = false;
  const f = controlled(t, {
    onSleep({ state, notify }) { if (!state.ready) { state.ready = true; notify(); } },
    onCollect: async ({ state, future }) => { if (future) { forecastActive = true; entered.resolve();
      try { await gate.promise; state.mono = 5100; } finally { forecastActive = false; } } },
    head: ({ lease }) => lease.current.pin.number,
  });
  const acquiredAt = [], pending = f.run({ connect: config => { assert.equal(forecastActive, false); acquiredAt.push(f.state.mono); return runner.connectForPass(config); } });
  await async.wait(entered.promise, pending, "FUTURE collection start"); await turn(); assert.equal(f.state.acquisitions, 1); assert.equal(f.state.active, 1);
  gate.resolve(); await pending; assert.deepEqual(acquiredAt, [0, 5100]); assert.equal(f.state.peak, 1);
});

test("external result fields/readiness callbacks cannot forge the private continuation handoff", async t => {
  const f = controlled(t, { head: ({ lease }) => lease.current.pin.number + 1 }); let invoked = 0;
  await f.run({ runPass: async args => {
    f.state.ready = true; f.notify();
    return { summary: { armed: false, targets: [], futureContinuation: "WAITING" }, resume: () => { invoked++; }, futureContinuation: () => { invoked++; } };
  } });
  assert.equal(invoked, 0); assert.equal(f.state.takes, 0); assert.equal(f.state.cancelled, true);
});

for (const measureOnly of [false, true]) test(`finite one-shot/measurement cleanup never retains optional continuation (${measureOnly})`, async t => {
  const f = controlled(t, { measureOnly, maxRuns: 1 });
  if (measureOnly) { f.lease.takeFuture = forbidden; f.lease.onFutureReady = forbidden; }
  await f.run(); assert.equal(f.state.subscribed, 0); assert.equal(f.state.collections.length, 1); assert.equal(f.state.cancelled, true);
  assert.equal(f.f.state.nonces, 0); assert.equal(f.f.state.signs, 0); assert.equal(f.state.closes, 1);
});

test("standalone allow flag without main's private owner preserves destructive take/cleanup and cannot retain a lease", async t => {
  const async = asyncHarness(t), f = live.fixture(async.fixtureContext); let takes = 0, cancels = 0;
  const current = { ...f.pinned, evidence: { ...f.pinned.evidence, nextBlockQualified: false }, nextBlock: undefined };
  const lease = { current, isFutureReady: () => false, takeFuture() { takes++; return null; }, cancelFuture() { cancels++; } };
  async.onCleanup(() => lease.cancelFuture());
  const budget = runner.createM1V2Budget({ wallNow: () => f.state.now, monotonicNow: () => 0 }); budget.bind(lease);
  await async.run(() => f.run({ argv: FLAGS, pinned: current, allowFutureContinuation: true, futureContinuationOwner: {},
    hotPathLease: lease, m1Budget: budget }));
  assert.equal(takes, 1); assert.ok(cancels > 0);
});

function header(number = HEAD) { return { number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(7),
  timestamp: hex(TIME + (number - HEAD) * 12), baseFeePerGas: hex(100000000), gasLimit: hex(30000000) }; }

for (const slowRead of ["latest", "canonical"]) test(`real factory + production collector: asymmetric positive RTT (${slowRead}) leaves FUTURE late, then same-lease idle continuation admits once`, async t => {
  const async = asyncHarness(t);
  const candidates = [0, 1].map(i => ({ family: `OFFLINE_FAMILY_${i}`, handle: `OFFLINE_HANDLE_${i}` }));
  const rate = new Interface(["function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns(uint256)"]);
  const W = 10n ** 18n, market = [2000000n * W, 2000000n * W * 1000000n, 1000000n * W - 1n,
    1000000n * W * 1000000n - 1000000n, BigInt(TIME), 0n], position = [0n, (86000n * W - W / 100n) * 1000000n, 100000n * W];
  const start = performance.now(), now = () => NOW + Math.floor(performance.now() - start);
  const state = { delayed: false, latest: [0, 0], canonical: [0, 0], acquisitions: 0, leases: [], takes: 0, notifications: 0, calls: [], collections: [], outputs: [], currentDone: 0, readyAt: 0, nextHead: false };
  const rpc = async (candidate, method, params) => {
    const alias = Number(candidate.handle.at(-1)), call = { alias, method, params }; state.calls.push(call);
    const ordinal = method === "eth_getBlockByNumber" && params[0] === "latest" ? ++state.latest[alias] : 0;
    const canonicalOrdinal = method === "eth_getBlockByNumber" && params[0] === hex(HEAD) ? ++state.canonical[alias] : 0;
    if (state.delayed) await sleep(15 + (state.acquisitions === 1 && alias === 1 && (slowRead === "latest" ? ordinal : canonicalOrdinal) === 3 ? 182 : 0));
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return header(params[0] === "latest" ? HEAD : Number(BigInt(params[0])));
    if (["eth_call", "eth_getCode", "eth_simulateV1"].includes(method) && params[1].blockHash === UNKNOWN) throw new guard.ExecutionError("UNKNOWN_BLOCK_REJECTED");
    if (method === "eth_getCode") return "0x6001";
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_getBalance") return hex(2000000000000000n);
    if (method === "eth_simulateV1") {
      const block = params[0].blockStateCalls[0];
      return [{ parentHash: params[1].blockHash, number: block.blockOverrides.number, timestamp: block.blockOverrides.time,
        transactions: [block.calls[0]], calls: [{ status: "0x1", gasUsed: hex(80000), logs: [],
          returnData: hash(BigInt(block.blockOverrides.number)) + hash(BigInt(block.blockOverrides.time)).slice(2) }] }];
    }
    assert.equal(method, "eth_call");
    if (params[0].data === transport.PROBE.encodeFunctionData("getBlockNumber")) return hash(BigInt(params[1].blockHash));
    const rows = m1.MULTI_IFACE.decodeFunctionData("aggregate3", params[0].data)[0];
    return m1.MULTI_IFACE.encodeFunctionResult("aggregate3", [rows.map((row, i) => ({ success: true, returnData: rows.length === 1
      ? rate.encodeFunctionResult("borrowRateView", [100000000000n])
      : m1.STATE_IFACE.encodeFunctionResult(["market", "position", "price"][i], [market, position, [10n ** 36n]][i]) }))]);
  };
  const factory = transport.createM1HotPathFactory({ rpc: (...args) => async.observe(rpc(...args)), now, monotonic: () => performance.now() - start, allowFuture: true });
  async.onCleanup(() => factory.close()); factory.maintain({ candidates }); await turn(); assert.equal(factory.maintain({ candidates }).selection, "READY");
  state.latest = [0, 0]; state.canonical = [0, 0]; state.delayed = true;
  await async.run(() => runner.main([...FLAGS, "--check"], {
    wallNow: now, monotonicNow: () => performance.now() - start,
    loadCandidates: () => candidates, loadBatch: () => ({}), connect: args => runner.connectForPass(args),
    createM1HotPathFactory: () => ({ maintain: factory.maintain, close: factory.close, acquire: async input => {
      state.acquisitions++; const base = await factory.acquire(input);
      const lease = Object.freeze({ ...base, onFutureReady: wake => base.onFutureReady(() => { state.notifications++; state.readyAt = performance.now(); wake(); }),
        takeFuture() { state.takes++; return base.takeFuture(); } });
      state.leases.push(lease); return lease;
    } }),
    runPass: args => runner.runPass({ ...args, now, amendmentReadFile: live.readEvidence, checkOnce: async config => {
      state.collections.push({ acquisition: state.acquisitions, future: !!config.nextBlockContext, pin: config.pin });
      const result = await watcher.checkOnce(config);
      if (state.acquisitions > 1) result.targets[m1.ID] = closedRow(result.targets[m1.ID]);
      return result;
    } }),
    liveHeadNumber: async () => { await sleep(5); return HEAD + (state.nextHead ? 1 : 0); },
    output: row => {
      state.outputs.push(row);
      if (row.run === 1 && row.passPhase === "CURRENT") {
        state.currentDone = performance.now(); assert.equal(state.leases[0].isFutureReady(), false); assert.equal(state.takes, 0);
        assert.equal(row.futureContinuation, "WAITING"); assert.equal(row.targets[0].positionStatus, "OPEN");
      }
      if (row.passPhase === "FUTURE_CONTINUATION") state.nextHead = true;
    },
  }));
  assert.ok(state.readyAt > state.currentDone, "real RTT reproduces late readiness, not a microtask-ready mock");
  assert.equal(state.notifications, 1); assert.equal(state.takes, 1); assert.equal(state.acquisitions, 2);
  assert.deepEqual(state.collections.map(c => [c.acquisition, c.future]), [[1, false], [1, true], [2, false]]);
  assert.deepEqual(state.collections[0].pin, state.collections[1].pin);
  const continuation = state.outputs.find(row => row.passPhase === "FUTURE_CONTINUATION");
  assert.equal(continuation.run, 1); assert.equal(continuation.candidateCount, 1); assert.equal(continuation.nextBlock.enabled, true);
  assert.equal(continuation.pin.hash, state.leases[0].current.pin.hash); assert.equal(continuation.phaseTimingsMs.acquisition, null);
  assert.equal(state.leases[0].takeFuture(), null); assert.equal(state.leases[0].isFutureReady(), false);
});
