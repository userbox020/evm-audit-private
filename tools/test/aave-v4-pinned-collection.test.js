"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface } = require("ethers");
const { openPinnedCollection, rpcRead, CollectionError } = require("../lib/aave-v4-pinned-collection");
const { REVIEWED_OPERATOR_FAMILY_IDS } = require("../lib/common-finalized-rpc-preflight");
const history = require("../lib/aave-v4-borrower-history");
const NOW = Date.parse("2026-09-20T20:00:00Z");
const ADDRESS = "0x" + "11".repeat(20);
const word = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
function header(n) { return { number: "0x" + n.toString(16), hash: word(n), parentHash: word(n - 1), stateRoot: word(900), timestamp: "0x" + (NOW / 1000 - 600).toString(16) }; }
function fixture(extra = []) {
  const calls = [];
  let active = 0;
  const state = { peak: 0, corrupt: false, failState: false };
  const candidates = [...extra, ...[0, 1].map(i => ({ handle: "good-" + i, operatorFamily: REVIEWED_OPERATOR_FAMILY_IDS[i], capabilityRank: 1, inventoryOrder: i + 10 }))];
  const rpc = async (handle, method, params) => {
    calls.push({ handle, method, params });
    active += 1; state.peak = Math.max(state.peak, active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      if (method === "eth_chainId") return handle === "wrong-chain" ? "0x2" : "0x1";
      if (method === "eth_getBlockByNumber") {
        const result = header(params[0] === "finalized" ? 100 : Number(BigInt(params[0])));
        return state.corrupt ? { ...result, hash: word(700) } : result;
      }
      if (method === "eth_getLogs") return [];
      if (handle === "no-hash-pin") throw new CollectionError("RPC_REJECTED");
      if (state.failState) throw new CollectionError("RPC_TRANSPORT");
      assert.equal(typeof params.at(-1), "object");
      assert.equal(params.at(-1).requireCanonical, true);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getStorageAt") return word(0);
      if (method === "eth_call") return word(1);
      throw new Error("Unexpected fixture method");
    } finally { active -= 1; }
  };
  return { calls, state, options: { now: () => NOW, candidates, rpc, probeAddress: ADDRESS } };
}

test("capabilities are qualified before independent families are selected; concurrency stays bounded", async () => {
  const f = fixture([
    { handle: "wrong-chain", operatorFamily: REVIEWED_OPERATOR_FAMILY_IDS[2], capabilityRank: 0, inventoryOrder: 0 },
    { handle: "no-hash-pin", operatorFamily: REVIEWED_OPERATOR_FAMILY_IDS[0], capabilityRank: 0, inventoryOrder: 1 },
  ]);
  const context = await openPinnedCollection(f.options);
  assert.equal(context.statistics().headerFamilies, 2);
  assert.equal(context.statistics().qualification.historyRequested, false);
  assert.equal(context.statistics().qualification.historyCapableCandidates, 0);
  assert.ok(f.state.peak <= 4);
  const before = f.calls.length;
  await context.provider.call({ to: ADDRESS, data: "0x" });
  assert.match(f.calls[before].handle, /^good-/);
});

test("state reads use the exact requested topology hash and require terminal confirmation", async () => {
  const f = fixture();
  const context = await openPinnedCollection({ ...f.options, requestedPin: { chainId: 1, finality: "finalized", blockNumber: 99, blockHash: word(99) } });
  const before = f.calls.length;
  await context.provider.call({ to: ADDRESS, data: "0x" });
  await context.provider.getCode(ADDRESS);
  await context.provider.getStorage(ADDRESS, word(0));
  const coverage = { stateReadsAttempted: 3, stateReadsSucceeded: 3, stateReadsFailed: 0 };
  assert.equal(context.observationPin(coverage), null);
  await context.confirmPin();
  const pin = context.observationPin(coverage);
  assert.equal(pin.blockHash, word(99));
  assert.equal(pin.stateRoot, word(900));
  assert.equal(pin.rpcStrength, "single-provider");
  assert.equal(pin.headerFamilies, 2);
  for (const row of f.calls.slice(before).filter(row => ["eth_call", "eth_getCode", "eth_getStorageAt"].includes(row.method))) {
    assert.deepEqual(row.params.at(-1), { blockHash: word(99), requireCanonical: true });
  }
  assert.equal(context.observationPin({ ...coverage, stateReadsAttempted: 4, stateReadsSucceeded: 4 }), null, "unperformed reads cannot be attested");
  f.state.corrupt = true;
  await assert.rejects(context.confirmPin(), { code: "TERMINAL_PIN_MISMATCH" });
  assert.equal(context.observationPin(coverage), null);
});

test("failed state reads and post-confirmation reads invalidate the pin attestation", async () => {
  const f = fixture();
  const context = await openPinnedCollection(f.options);
  await context.provider.call({ to: ADDRESS, data: "0x" });
  const coverage = { stateReadsAttempted: 1, stateReadsSucceeded: 1, stateReadsFailed: 0 };
  await context.confirmPin();
  assert.ok(context.observationPin(coverage));
  f.state.failState = true;
  await assert.rejects(context.provider.getCode(ADDRESS), { code: "RPC_TRANSPORT" });
  assert.equal(context.observationPin(coverage), null);
  await context.confirmPin();
  assert.equal(context.observationPin(coverage), null);
});

test("request budgets retain terminal reserve and reject ranges beyond the pin", async () => {
  const f = fixture();
  const context = await openPinnedCollection({ ...f.options, limits: { maxRequests: 160 } });
  await assert.rejects(context.provider.getLogs({ address: ADDRESS, topics: [], fromBlock: 0, toBlock: 101 }), { code: "INVALID_LOG_RANGE" });
  let nonce = 0;
  while (context.canCollect()) await context.provider.call({ to: ADDRESS, data: word(++nonce) });
  assert.equal((await context.checkpointBlock(50)).number, 50);
  await context.confirmPin();
  assert.ok(context.statistics().networkCalls <= 160);
  await assert.rejects(context.provider.getCode(ADDRESS), { code: "COLLECTION_BUDGET_EXHAUSTED" });
});

test("identical state reads are memoized only within the immutable pin session", async () => {
  const f = fixture();
  const context = await openPinnedCollection(f.options);
  await context.provider.getCode(ADDRESS);
  await context.provider.getCode(ADDRESS);
  assert.equal(context.statistics().stateRequests, 1);
  assert.equal(context.statistics().stateReadOperations, 2);
  assert.equal(context.statistics().stateCacheHits, 1);
  await context.confirmPin();
  assert.equal(context.observationPin({ stateReadsAttempted: 2, stateReadsSucceeded: 2, stateReadsFailed: 0 }).stateReadsPinned, 2);
  const other = await openPinnedCollection(f.options);
  await other.provider.getCode(ADDRESS);
  assert.equal(other.statistics().stateRequests, 1);
  assert.equal(other.statistics().stateCacheHits, 0);
});

test("bounded backfill can anchor its completed prefix after exhausting the ordinary request budget", async () => {
  const f = fixture();
  const context = await openPinnedCollection({ ...f.options, limits: { maxRequests: 160 } });
  for (let i = 1; i <= 40; i++) await context.provider.call({ to: ADDRESS, data: word(i) });
  const result = await history.advanceHistory(context, history.emptyHistory(history.historyIdentity([ADDRESS], "a".repeat(64))), { chunkSize: 1, maxChunks: 128 });
  assert.equal(result.complete, false);
  assert.ok(result.index.throughBlock >= 0 && result.index.throughBlock < context.pin.number);
  assert.ok(result.index.throughBlockHash);
  await context.confirmPin();
  assert.ok(context.statistics().networkCalls <= 160);
});

test("wrong-chain and unfinalized requested pins fail closed", async () => {
  for (const requestedPin of [
    { chainId: 8453, finality: "finalized", blockNumber: 99, blockHash: word(99) },
    { chainId: 1, finality: "latest", blockNumber: 99, blockHash: word(99) },
    { chainId: 1, finality: "finalized", blockNumber: 101, blockHash: word(101) },
  ]) {
    const f = fixture();
    await assert.rejects(openPinnedCollection({ ...f.options, requestedPin }), { code: "REQUESTED_PIN_INVALID" });
  }
});

test("the historical primary can use a non-archive independent header witness", async () => {
  const f = fixture();
  const baseRpc = f.options.rpc;
  f.options.rpc = (handle, method, params, timeout) => {
    if (handle === "good-1" && method === "eth_getLogs" && params[0].fromBlock === "0x0") throw new CollectionError("RPC_REJECTED");
    return baseRpc(handle, method, params, timeout);
  };
  const context = await openPinnedCollection({ ...f.options, historyProbe: { addresses: [ADDRESS], topic: word(1) } });
  assert.equal(context.statistics().headerFamilies, 2);
  assert.equal(context.statistics().qualification.historyCapableCandidates, 1);
  const before = f.calls.length;
  await context.provider.getLogs({ address: ADDRESS, topics: [word(1)], fromBlock: 0, toBlock: 1 });
  assert.equal(f.calls[before].handle, "good-0");
});

test("no historical primary fails with anonymous capability diagnostics", async () => {
  const f = fixture();
  const baseRpc = f.options.rpc;
  f.options.rpc = (handle, method, params, timeout) => {
    if (method === "eth_getLogs" && params[0].fromBlock === "0x0") throw new CollectionError("RPC_REJECTED");
    return baseRpc(handle, method, params, timeout);
  };
  await assert.rejects(openPinnedCollection({ ...f.options, historyProbe: { addresses: [ADDRESS], topic: word(1) } }), error => {
    assert.equal(error.code, "HISTORY_CAPABILITY_UNAVAILABLE");
    assert.equal(error.diagnostics.stateCapableCandidates, 2);
    assert.equal(error.diagnostics.historyCapableCandidates, 0);
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /good-|fixture/);
    return true;
  });
});

test("raw transport is read-only, byte-bounded, and does not expose provider error text", async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return { ok: true, body: [Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "SENSITIVE_FIXTURE_DETAIL" } }))] };
  };
  await assert.rejects(rpcRead("fixture", "eth_sendRawTransaction", [], 1000, { fetch }), { code: "METHOD_NOT_ALLOWED" });
  assert.equal(called, false);
  await assert.rejects(rpcRead("fixture", "eth_getCode", [], 1000, { fetch }), error => error.code === "RPC_REJECTED" && !error.message.includes("SENSITIVE"));
  await assert.rejects(rpcRead("fixture", "eth_getCode", [], 1000, { fetch, maxBytes: 8 }), { code: "RPC_RESPONSE_TOO_LARGE" });
});

const VIEWS = new Interface([
  "function multicall(bytes[]) returns(bytes[])",
  "function getUserTotalDebt(uint256,address) view returns(uint256)",
]);
const user = n => "0x" + BigInt(n).toString(16).padStart(40, "0");
const view = n => ({ to: ADDRESS, data: VIEWS.encodeFunctionData("getUserTotalDebt", [0, user(n)]) });
function batchedFixture() {
  const f = fixture();
  const original = f.options.rpc;
  const state = { wrongLength: false, mismatch: false, transportFailed: false, revertUser: null, peak: 0, batches: [] };
  let active = 0;
  function evaluate(data) {
    const parsed = VIEWS.parseTransaction({ data });
    const account = Number(BigInt(parsed.args[1]));
    if (account === state.revertUser) throw new CollectionError("CALL_EXCEPTION");
    return VIEWS.encodeFunctionResult(parsed.name, [account]);
  }
  f.options.historyProbe = { addresses: [ADDRESS], topic: word(1) };
  f.options.rpc = async (handle, method, params, timeout) => {
    const parsed = method === "eth_call" ? VIEWS.parseTransaction({ data: params[0].data }) : null;
    if (!parsed) return original(handle, method, params, timeout);
    active += 1; state.peak = Math.max(state.peak, active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(params.at(-1), { blockHash: word(100), requireCanonical: true });
      assert.deepEqual(Object.keys(params[0]).sort(), ["data", "to"]);
      if (parsed.name !== "multicall") return evaluate(params[0].data);
      const data = Array.from(parsed.args[0]); state.batches.push(data.length);
      if (state.transportFailed) throw new CollectionError("RPC_TRANSPORT");
      const results = data.map(evaluate);
      if (state.wrongLength) results.pop();
      if (state.mismatch) results[0] = word(999999);
      return VIEWS.encodeFunctionResult("multicall", [results]);
    } finally { active -= 1; }
  };
  return { ...f, batch: state };
}

test("native view batches preserve order, pin and caller, with bounded payload/concurrency and physical accounting", async () => {
  const f = batchedFixture();
  const context = await openPinnedCollection({ ...f.options, limits: { maxRequests: 160 } });
  const before = context.statistics().networkCalls;
  const result = await context.provider.callMany(Array.from({ length: 260 }, (_, i) => view(i + 1)));
  assert.deepEqual(result.map(row => Number(BigInt(row.value))), Array.from({ length: 260 }, (_, i) => i + 1));
  assert.equal(context.statistics().networkCalls - before, 7, "two comparison reads plus five batches, not 260 RPCs");
  assert.equal(context.statistics().viewBatchComparisons, 1);
  assert.equal(context.statistics().viewBatchSubcalls, 260);
  assert.ok(f.batch.batches.every(size => size <= 64));
  assert.ok(f.batch.peak <= 4 && f.batch.peak > 1);
  await context.confirmPin();
  assert.equal(context.observationPin({ stateReadsAttempted: 260, stateReadsSucceeded: 260, stateReadsFailed: 0 }).stateReadsPinned, 260);
});

test("native batches reject undeclared targets, non-view/nested selectors, value and oversized input before dispatch", async () => {
  const f = batchedFixture(); const context = await openPinnedCollection(f.options);
  const before = context.statistics().networkCalls;
  for (const input of [
    [{ ...view(1), to: user(999) }], [{ to: ADDRESS, data: "0x095ea7b3" + "0".repeat(128) }],
    [{ to: ADDRESS, data: VIEWS.encodeFunctionData("multicall", [[]]) }], [{ ...view(1), value: "0x1" }],
    [{ ...view(1), data: view(1).data + "00" }], Array(32769).fill(view(1)),
  ]) await assert.rejects(context.provider.callMany(input), { code: "INVALID_VIEW_BATCH" });
  assert.equal(context.statistics().networkCalls, before);
});

test("malformed, inequivalent or transport-failed native results cannot attest complete state", async () => {
  for (const [mutation, code] of [["wrongLength", "INVALID_MULTICALL_RESULT"], ["mismatch", "MULTICALL_EQUIVALENCE_FAILED"], ["transportFailed", "RPC_TRANSPORT"]]) {
    const f = batchedFixture(); const context = await openPinnedCollection(f.options);
    f.batch[mutation] = true;
    const result = await context.provider.callMany([view(1), view(2)]);
    assert.ok(result.every(row => row.error === code));
    await context.confirmPin();
    assert.equal(context.observationPin({ stateReadsAttempted: 2, stateReadsSucceeded: 2, stateReadsFailed: 0 }), null);
  }
});

test("a native batch revert is isolated instead of attributed to every member", async () => {
  const f = batchedFixture(); const context = await openPinnedCollection(f.options);
  f.batch.revertUser = 37;
  const result = await context.provider.callMany(Array.from({ length: 64 }, (_, i) => view(i + 1)));
  assert.equal(result.filter(row => row.error).length, 1);
  assert.equal(result[36].error, "CALL_EXCEPTION");
  assert.equal(result[35].value, word(36)); assert.equal(result[37].value, word(38));
  assert.ok(context.statistics().viewBatchSplits > 0);
  assert.equal(context.statistics().stateTransportFailures, 0);
  await context.confirmPin();
  assert.equal(context.observationPin({ stateReadsAttempted: 64, stateReadsSucceeded: 63, stateReadsFailed: 1 }), null);
});

test("batched request and elapsed-time exhaustion retain terminal reserve and fail closed", async () => {
  for (const deadline of [false, true]) {
    const f = batchedFixture(); let now = NOW;
    const context = await openPinnedCollection({ ...f.options, now: () => now, limits: { maxRequests: 160 } });
    await context.provider.callMany([view(1)]);
    if (deadline) now += 211000;
    const result = await context.provider.callMany(Array.from({ length: deadline ? 64 : 10000 }, (_, i) => view(i + 2)));
    assert.ok(result.some(row => row.error === "COLLECTION_BUDGET_EXHAUSTED"));
    await context.confirmPin();
    assert.ok(context.statistics().networkCalls <= 160);
    assert.equal(context.observationPin({ stateReadsAttempted: 1, stateReadsSucceeded: 1, stateReadsFailed: 0 }), null);
  }
});

test("budget snapshots are immutable numeric observations, not request reservations", async () => {
  const f = fixture();
  const context = await openPinnedCollection({ ...f.options, limits: { maxRequests: 160, privateMetadata: "SYNTHETIC_PRIVATE" } });
  const before = context.budgetStatus();
  assert.equal(before.effectiveLimits.maxRequests, 160);
  assert.equal(before.ordinaryTimeRemainingMs, 210000);
  assert.equal(before.elapsedMs, 0);
  assert.equal(before.outstandingRequests, 0);
  assert.ok(Object.isFrozen(before) && Object.isFrozen(before.effectiveLimits));
  assert.deepEqual(context.budgetStatus(), before);
  await context.provider.getCode(ADDRESS);
  assert.equal(context.budgetStatus().ordinaryRequestsRemaining, before.ordinaryRequestsRemaining - 1);
  assert.doesNotMatch(JSON.stringify(context.statistics()), /SYNTHETIC_PRIVATE|privateMetadata|good-/);
});

test("budget snapshots account for active and queued physical requests without double charging", async () => {
  const f = fixture();
  let hold = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const rpc = async (...args) => { if (hold && args[1] === "eth_call") await gate; return f.options.rpc(...args); };
  const context = await openPinnedCollection({ ...f.options, rpc });
  const before = context.budgetStatus();
  hold = true;
  const pending = Array.from({ length: 6 }, (_, i) => context.provider.call({ to: ADDRESS, data: word(i + 1) }));
  const busy = context.budgetStatus();
  assert.equal(busy.activeRequests, 4);
  assert.equal(busy.queuedRequests, 2);
  assert.equal(busy.outstandingRequests, 6);
  assert.equal(busy.ordinaryRequestsRemaining, before.ordinaryRequestsRemaining - 6);
  release(); await Promise.all(pending);
  assert.equal(context.budgetStatus().outstandingRequests, 0);
});

test("first budget rejection retains only fixed method/reason and numeric budget, for each boundary", async () => {
  for (const mode of ["REQUEST_THRESHOLD", "TIME_THRESHOLD", "BOTH"]) {
    const f = fixture(); let now = NOW;
    const context = await openPinnedCollection({ ...f.options, now: () => now, limits: { maxRequests: 160 } });
    if (mode !== "TIME_THRESHOLD") {
      let nonce = 0;
      while (context.canCollect()) await context.provider.call({ to: ADDRESS, data: word(++nonce) });
    }
    if (mode !== "REQUEST_THRESHOLD") now += 210000;
    await assert.rejects(context.provider.getCode(ADDRESS), { code: "COLLECTION_BUDGET_EXHAUSTED" });
    const first = context.statistics().firstRejectedDispatch;
    assert.equal(first.reason, mode);
    assert.equal(first.method, "eth_getCode");
    assert.deepEqual(Object.keys(first).sort(), ["budget", "method", "reason"]);
    await assert.rejects(context.provider.getStorage(ADDRESS, word(0)), { code: "COLLECTION_BUDGET_EXHAUSTED" });
    assert.deepEqual(context.statistics().firstRejectedDispatch, first);
    assert.equal(context.statistics().rejectedRequests, 2);
    await context.confirmPin();
    assert.equal(context.observationPin({ stateReadsAttempted: 0, stateReadsSucceeded: 0, stateReadsFailed: 0 }), null);
    assert.doesNotMatch(JSON.stringify(first), /good-|https?:|params|handle|error|body|0x1111/);
  }
});

test("cache hits at the ordinary time boundary need no dispatch and never clear an earlier rejection", async () => {
  const f = fixture(); let now = NOW;
  const context = await openPinnedCollection({ ...f.options, now: () => now });
  await context.provider.getCode(ADDRESS);
  const calls = context.statistics().networkCalls;
  now += 210000;
  assert.equal(await context.provider.getCode(ADDRESS), "0x6000");
  assert.equal(context.statistics().networkCalls, calls);
  assert.equal(context.statistics().rejectedRequests, 0);
  await context.confirmPin();
  assert.ok(context.observationPin({ stateReadsAttempted: 2, stateReadsSucceeded: 2, stateReadsFailed: 0 }));
  await assert.rejects(context.provider.getCode(user(999)), { code: "COLLECTION_BUDGET_EXHAUSTED" });
  await context.provider.getCode(ADDRESS);
  await context.confirmPin();
  assert.equal(context.statistics().rejectedRequests, 1);
  assert.equal(context.observationPin({ stateReadsAttempted: 2, stateReadsSucceeded: 2, stateReadsFailed: 0 }), null);
});
