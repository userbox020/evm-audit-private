"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getEventListeners } = require("node:events");
const deadline = require("../lib/producer-deadline");
const shared = require("../shared-rpc");

// Scanner imports capture only these mock forwarding functions. No inventory or
// real network is reachable, even when a regression accidentally admits a retry.
let transport = () => { throw new Error("UNEXPECTED_MOCK_RPC"); };
let resolver = async () => "https://mock.invalid";
let inventoryReads = 0;
const originalShared = { rpcCall: shared.rpcCall, resolveRpc: shared.resolveRpc, loadRpcUrls: shared.loadRpcUrls };
Object.assign(shared, {
  rpcCall: (...args) => transport(...args),
  resolveRpc: (...args) => resolver(...args),
  loadRpcUrls: () => { inventoryReads += 1; return []; },
});
const morpho = require("../scan-morpho-blue-l");
const aaveL = require("../scan-aave-v3-l");
const aaveOf = require("../scan-aave-v3-of");
Object.assign(shared, originalShared);

const actualFetch = global.fetch;
const deniedFetch = () => { throw new Error("NETWORK_PROHIBITED"); };
global.fetch = deniedFetch;
test.after(() => { global.fetch = actualFetch; });
test.afterEach(() => { global.fetch = deniedFetch; });
const tick = () => new Promise(resolve => setImmediate(resolve));
const code = expected => error => error.code === expected;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("outside a scope invoke/check/sleep/join preserve ordinary successful behavior", async () => {
  assert.equal(deadline.current(), null);
  deadline.check();
  assert.equal(await deadline.invoke(() => Promise.resolve(7)), 7);
  assert.deepEqual(await deadline.join([Promise.resolve(1), Promise.resolve(2)]), [1, 2]);
  await deadline.sleep(1);
});

test("absolute monotonic expiry rejects late success even before a timer callback", async () => {
  let now = 0;
  let scope;
  await assert.rejects(deadline.run(() => {
    scope = deadline.current();
    assert.equal(Object.isFrozen(scope), true);
    assert.equal(scope.deadline, 10);
    now = 11;
    return "too late";
  }, 10, { clock: () => now }), code("TIMEOUT"));
  assert.equal(scope.signal.aborted, true);
  assert.equal(await deadline.run(() => 9, 10, { clock: () => 0 }), 9);
});

test("invoke guards admission and post-await failures without leaking raw errors", async () => {
  let now = 0;
  let admissions = 0;
  await assert.rejects(deadline.run(async () => {
    await deadline.invoke(async () => { admissions += 1; now = 11; throw new Error("MOCK_FAILURE"); });
    await deadline.invoke(() => { admissions += 1; });
  }, 10, { clock: () => now }), code("TIMEOUT"));
  assert.equal(admissions, 1);
});

test("join observes all siblings before propagating an ordinary failure", async () => {
  let siblingSettled = false;
  await assert.rejects(deadline.run(() => deadline.join([
    Promise.reject(new Error("FIRST_FAILURE")),
    tick().then(() => { siblingSettled = true; }),
  ]), 1000), /FIRST_FAILURE/);
  assert.equal(siblingSettled, true);
});

test("producer failure closes admission and drains its original detached operation", async () => {
  let settled = false;
  await assert.rejects(deadline.run(() => {
    const signal = deadline.current().signal;
    deadline.invoke(() => new Promise((_, reject) => signal.addEventListener("abort", () => {
      setImmediate(() => { settled = true; reject(new Error("MOCK_ABORT")); });
    }, { once: true })));
    throw new Error("PRODUCER_FAILURE");
  }, 1000), /PRODUCER_FAILURE/);
  assert.equal(settled, true);
});

test("original ignored-signal work outlives wrappers and forces unconfirmed drain", async () => {
  const original = deferred();
  let signal;
  try {
    await assert.rejects(deadline.run(() => {
      signal = deadline.current().signal;
      deadline.invoke(() => original.promise);
      return "not safely drained";
    }, 1000, { drainGraceMs: 5 }), code("DRAIN_UNCONFIRMED"));
    assert.equal(signal.aborted, true);
  } finally { original.reject(new Error("LATE_FAILURE")); await tick(); }
});

test("abortable sleep removes its listener and original timer on expiry", async () => {
  let signal;
  await assert.rejects(deadline.run(async () => {
    signal = deadline.current().signal;
    await deadline.sleep(60_000);
  }, 10), code("TIMEOUT"));
  assert.equal(getEventListeners(signal, "abort").length, 0);
});

test("shared transport pre-abort admits no fetch and cleans supplied listeners", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetches = 0;
  global.fetch = () => { fetches += 1; throw new Error("UNEXPECTED_FETCH"); };
  assert.equal(await shared.rpcCall("https://mock.invalid", "eth_chainId", [], 1000, { signal: controller.signal }), null);
  assert.equal(fetches, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("supplied abort after an ignored fetch prevents body admission outside ALS", async () => {
  const controller = new AbortController();
  let bodies = 0;
  global.fetch = async () => {
    controller.abort();
    return { ok: true, json: async () => { bodies += 1; return { jsonrpc: "2.0", id: 1, result: "0x1" }; } };
  };
  assert.equal(await shared.rpcCall("https://mock.invalid", "eth_chainId", [], 1000, { signal: controller.signal }), null);
  assert.equal(bodies, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("supplied abort cancels a pending body outside ALS and cleans listeners", async () => {
  const controller = new AbortController();
  let cancelled = false;
  global.fetch = async (_url, { signal }) => ({
    ok: true,
    json: () => new Promise((_, reject) => {
      signal.addEventListener("abort", () => { cancelled = true; reject(new Error("MOCK_BODY_ABORT")); }, { once: true });
      queueMicrotask(() => controller.abort());
    }),
  });
  assert.equal(await shared.rpcCall("https://mock.invalid", "eth_chainId", [], 1000, { signal: controller.signal }), null);
  assert.equal(cancelled, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("shared transport cancels original fetch and retains scoped TIMEOUT", async () => {
  let fetches = 0;
  global.fetch = (_url, { signal }) => {
    fetches += 1;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("MOCK_ABORT")), { once: true }));
  };
  await assert.rejects(deadline.run(() => shared.rpcCall("https://mock.invalid", "eth_chainId", []), 10), code("TIMEOUT"));
  assert.equal(fetches, 1);
});

test("shared cancellation stays connected through response body and cleans listeners", async () => {
  const supplied = new AbortController();
  let bodySettled = false;
  let scopeSignal;
  global.fetch = async (_url, { signal }) => ({
    ok: true,
    json: () => new Promise((_, reject) => {
      assert.equal(getEventListeners(supplied.signal, "abort").length, 1);
      signal.addEventListener("abort", () => { bodySettled = true; reject(new Error("BODY_ABORT")); }, { once: true });
    }),
  });
  await assert.rejects(deadline.run(() => {
    scopeSignal = deadline.current().signal;
    return shared.rpcCallStrict("https://mock.invalid", "eth_chainId", [], 8000, { signal: supplied.signal });
  }, 10), code("TIMEOUT"));
  assert.equal(bodySettled, true);
  assert.equal(getEventListeners(supplied.signal, "abort").length, 0);
  assert.equal(getEventListeners(scopeSignal, "abort").length, 0);
});

test("an ignored response-body abort stays tracked until late rejection", async () => {
  const body = deferred();
  const supplied = new AbortController();
  global.fetch = async () => ({ ok: true, json: () => body.promise });
  try {
    await assert.rejects(deadline.run(() => shared.rpcCall("https://mock.invalid", "eth_chainId", [], 8000,
      { signal: supplied.signal }), 10, { drainGraceMs: 5 }), code("DRAIN_UNCONFIRMED"));
  } finally { body.reject(new Error("LATE_BODY_FAILURE")); await tick(); }
  assert.equal(getEventListeners(supplied.signal, "abort").length, 0);
});

test("successful four-argument transport consumes body before listener cleanup", async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x1" }) });
  assert.equal(await shared.rpcCallStrict("https://mock.invalid", "eth_chainId", [], 1000), "0x1");
});

for (const scoped of [false, true]) {
  test(`synchronous qualification transport failure tries the next candidate (ALS: ${scoped})`, async () => {
    const first = "https://mock-first.invalid";
    const second = "https://mock-second.invalid";
    const calls = [];
    const resolve = () => shared.resolveRpc(1, [first, second], {
      concurrency: 1, publicFallbacks: {},
      rpcCall: (url, method, _params, _ms, { signal }) => {
        calls.push({ url, method });
        assert.equal(signal.aborted, false);
        if (url === first) throw new Error("SYNCHRONOUS_MOCK_FAILURE");
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_blockNumber") return "0x10";
        if (method === "eth_call" || method === "eth_getCode") return "0x";
        if (method === "eth_getStorageAt") return `0x${"0".repeat(64)}`;
        throw new Error("UNEXPECTED_MOCK_METHOD");
      },
    });
    const selected = await (scoped ? deadline.run(resolve, 1000) : resolve());
    assert.equal(selected, second);
    assert.deepEqual(calls.filter(call => call.url === first).map(call => call.method), ["eth_chainId"]);
    assert.deepEqual(calls.filter(call => call.url === second).map(call => call.method),
      ["eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode", "eth_getStorageAt"]);
  });
}

test("synchronous transport failure at expiry admits neither another candidate nor fallback", async () => {
  let now = 0;
  let calls = 0;
  await assert.rejects(deadline.run(() => shared.resolveRpc(1,
    ["https://mock-first.invalid", "https://mock-second.invalid"], {
      concurrency: 1, publicFallbacks: { 1: "https://mock-fallback.invalid" },
      rpcCall: () => { calls += 1; now = 11; throw new Error("SYNCHRONOUS_MOCK_FAILURE"); },
    }), 10, { clock: () => now }), code("TIMEOUT"));
  assert.equal(calls, 1);
});

test("a custom qualification transport survives request timeout but cannot escape drain", async () => {
  const original = deferred();
  let calls = 0;
  let signal;
  try {
    await assert.rejects(deadline.run(() => shared.resolveRpc(1, ["https://mock.invalid"], {
      timeoutMs: 5, publicFallbacks: {},
      rpcCall: (_url, _method, _params, _ms, options) => { calls += 1; signal = options.signal; return original.promise; },
    }), 1000, { drainGraceMs: 5 }), code("DRAIN_UNCONFIRMED"));
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
  } finally { original.reject(new Error("LATE_CUSTOM_FAILURE")); await tick(); }
});

test("parallel qualification drains aborted siblings without admitting fallback", async () => {
  let calls = 0;
  let siblingSettled = false;
  await assert.rejects(deadline.run(() => shared.resolveRpc(1, ["https://mock-a.invalid", "https://mock-b.invalid"], {
    publicFallbacks: { 1: "https://mock-fallback.invalid" },
    rpcCall: (_url, _method, _params, _ms, { signal }) => {
      calls += 1;
      return new Promise((_, reject) => signal.addEventListener("abort", () => {
        setImmediate(() => { siblingSettled = true; reject(new Error("MOCK_ABORT")); });
      }, { once: true }));
    },
  }), 10), code("TIMEOUT"));
  assert.equal(calls, 2);
  assert.equal(siblingSettled, true);
});

for (const [name, scanner] of [["Morpho", morpho], ["Aave L", aaveL], ["Aave O/F", aaveOf]]) {
  test(`${name} endpoint resolution cannot fall back after scoped expiry`, async () => {
    let now = 0;
    inventoryReads = 0;
    resolver = async () => { now = 11; return null; };
    const operation = name === "Morpho" ? () => scanner.resolveWorkingRpc(1)
      : name === "Aave L" ? () => scanner.resolveLogRpc(1)
        : () => scanner.listWorkingRpcs(1, scanner.CHAINS[1], "0x1");
    try {
      await assert.rejects(deadline.run(operation, 10, { clock: () => now }), code("TIMEOUT"));
      assert.equal(inventoryReads, 0);
    } finally { resolver = async () => "https://mock.invalid"; }
  });
}

test("Aave recursive range failure at expiry neither splits nor checkpoints BACKFILL_FAILURE", async () => {
  let now = 0;
  let calls = 0;
  let writes = 0;
  transport = async () => { calls += 1; now = 11; throw new Error("MOCK_READ_FAILURE"); };
  const config = { ...aaveL.CHAINS[1], deployBlock: 1, logChunk: 10_000 };
  const index = aaveL.emptyIndex(config);
  index.historyStartBound = { proven: true };
  await assert.rejects(deadline.run(() => aaveL.syncIndex(index, {
    config, rpc: "https://mock.invalid", finalizedBlock: 10,
    fsImpl: { mkdirSync() {}, writeFileSync() { writes += 1; } },
  }), 10, { clock: () => now }), code("TIMEOUT"));
  assert.equal(calls, 1);
  assert.equal(index.failures, 0);
  assert.equal(writes, 0);
});

for (const [name, scanner] of [["Morpho", morpho], ["Aave L", aaveL]]) {
  test(`${name} recursive backfill expiry admits no split, retry or failure checkpoint`, async () => {
    let now = 0;
    let calls = 0;
    let writes = 0;
    transport = async () => { calls += 1; now = 11; throw new Error("MOCK_READ_FAILURE"); };
    const config = { ...scanner.CHAINS[1], deployBlock: 1 };
    const index = scanner.emptyIndex(config);
    await assert.rejects(deadline.run(() => scanner.backfillParallel(index, {
      rpc: "https://mock.invalid", config, finalized: 10, chunkSize: 10, concurrency: 1, indexPath: "mock-index.json",
      fsImpl: { mkdirSync() {}, writeFileSync() { writes += 1; } },
    }), 10, { clock: () => now }), code("TIMEOUT"));
    assert.equal(calls, 1);
    assert.equal(index.failures, 0);
    assert.equal(index.cursor, 1);
    assert.equal(writes, 0);
  });
}

test("Morpho quote retry and multicall dequeue stop at expiry", async () => {
  let now = 0;
  let calls = 0;
  transport = async () => { calls += 1; now = 11; return null; };
  await assert.rejects(deadline.run(() => morpho.multicall("https://mock.invalid", "0x1", [
    { to: morpho.MORPHO, data: "0x" }, { to: morpho.MORPHO, data: "0x" },
  ], { batchSize: 1, concurrency: 1 }), 10, { clock: () => now }), code("TIMEOUT"));
  assert.equal(calls, 1);
});

for (const [name, scanner] of [["Aave L", aaveL], ["Aave O/F", aaveOf]]) {
  test(`${name} multicall retry cannot suppress expiry or start a retry`, async () => {
    let now = 0;
    let calls = 0;
    const original = morpho.multicall;
    morpho.multicall = async () => { calls += 1; now = 11; return { results: [null], failures: 1 }; };
    try {
      await assert.rejects(deadline.run(() => scanner.multicallRetry("https://mock.invalid", "0x1", [{}]),
        10, { clock: () => now }), code("TIMEOUT"));
      assert.equal(calls, 1);
    } finally { morpho.multicall = original; }
  });
}

test("optional Aave provider-oracle fallback cannot swallow expiry", async () => {
  let now = 0;
  let calls = 0;
  transport = async () => {
    calls += 1;
    if (calls === 1) return aaveOf.IFACE.pool.encodeFunctionResult("getReservesList", [[]]);
    now = 11;
    throw new Error("OPTIONAL_PROVIDER_FAILURE");
  };
  await assert.rejects(deadline.run(() => aaveOf.readReserves("https://mock.invalid", "0x1", aaveOf.CHAINS[1]),
    10, { clock: () => now }), code("TIMEOUT"));
  assert.equal(calls, 2);
});

test("optional Morpho gas oracle cannot convert expiry into a completed observation", async () => {
  let now = 0;
  let calls = 0;
  transport = async () => { calls += 1; now = 11; throw new Error("MOCK_ORACLE_FAILURE"); };
  await assert.rejects(deadline.run(() => morpho.valuateCandidates({
    rpc: "https://mock.invalid", blockRef: "0x1", blockTimestamp: 1n, activeCandidates: [{ liquidatable: true }],
  }), 10, { clock: () => now }), code("TIMEOUT"));
  assert.equal(calls, 1);
});

test("Morpho pool workers settle every sibling before expiry propagates", async () => {
  let now = 0;
  let settled = false;
  let starts = 0;
  await assert.rejects(deadline.run(() => morpho.poolMap([1, 2, 3], 2, async (item) => {
    starts += 1;
    if (item === 1) { await tick(); now = 11; throw new Error("MOCK_FAILURE"); }
    await new Promise(resolve => deadline.current().signal.addEventListener("abort", () => {
      setImmediate(() => { settled = true; resolve(); });
    }, { once: true }));
  }), 10, { clock: () => now }), code("TIMEOUT"));
  assert.equal(starts, 2);
  assert.equal(settled, true);
});

test("Morpho optional IRM reads drain siblings instead of swallowing expiry", async () => {
  let now = 0;
  let irmCalls = 0;
  let settled = false;
  const address = digit => `0x${digit.repeat(40)}`;
  transport = async (_rpc, _method, [request]) => {
    if (request.to === morpho.MULTICALL3) {
      const [entries] = morpho.I.multicall.decodeFunctionData("aggregate3", request.data);
      const tuples = entries.map(entry => {
        const selector = entry.callData.slice(0, 10);
        const data = selector === morpho.I.params.getFunction("idToMarketParams").selector
          ? morpho.I.params.encodeFunctionResult("idToMarketParams", [address("1"), address("2"), address("3"), address("4"), 8n * 10n ** 17n])
          : selector === morpho.I.market.getFunction("market").selector
            ? morpho.I.market.encodeFunctionResult("market", [1n, 1n, 1n, 1n, 0n, 0n])
            : morpho.I.oracle.encodeFunctionResult("price", [10n ** 36n]);
        return [true, data];
      });
      return morpho.I.multicall.encodeFunctionResult("aggregate3", [tuples]);
    }
    irmCalls += 1;
    if (irmCalls === 1) { await tick(); now = 11; throw new Error("IRM_FAILURE"); }
    await new Promise(resolve => deadline.current().signal.addEventListener("abort", () => {
      setImmediate(() => { settled = true; resolve(); });
    }, { once: true }));
    return morpho.I.irm.encodeFunctionResult("borrowRate", [0n]);
  };
  await assert.rejects(deadline.run(() => morpho.resolveMarkets("https://mock.invalid", "0x1", 1n,
    [`0x${"a".repeat(64)}`, `0x${"b".repeat(64)}`]), 10, { clock: () => now }), code("TIMEOUT"));
  assert.equal(irmCalls, 2);
  assert.equal(settled, true);
});

test("Morpho injected backfill chunks drain without post-expiry index mutation or writes", async () => {
  let now = 0;
  let settled = false;
  let starts = 0;
  let writes = 0;
  const config = { ...morpho.CHAINS[1], deployBlock: 1 };
  const index = morpho.emptyIndex(config);
  await assert.rejects(deadline.run(() => morpho.backfillParallel(index, {
    rpc: "https://mock.invalid", config, finalized: 3, chunkSize: 1, concurrency: 2, indexPath: "mock-index.json",
    fsImpl: { mkdirSync() {}, writeFileSync() { writes += 1; } },
    fetchChunk: async (from) => {
      starts += 1;
      if (from === 1) { await tick(); now = 11; throw new Error("MOCK_FAILURE"); }
      await new Promise(resolve => deadline.current().signal.addEventListener("abort", () => {
        setImmediate(() => { settled = true; resolve(); });
      }, { once: true }));
      return [];
    },
  }), 10, { clock: () => now }), code("TIMEOUT"));
  assert.equal(starts, 2);
  assert.equal(settled, true);
  assert.equal(index.chunkReads, 0);
  assert.equal(index.cursor, 1);
  assert.deepEqual(index.backfill.done, []);
  assert.equal(writes, 0);
});

test("Aave backfill expiry drains siblings without post-fetch mutation or failure checkpoint", async () => {
  let now = 0;
  let settled = false;
  let starts = 0;
  let writes = 0;
  transport = async (_rpc, _method, [filter]) => {
    starts += 1;
    if (filter.fromBlock === "0x1") { await tick(); now = 11; throw new Error("MOCK_FAILURE"); }
    await new Promise(resolve => deadline.current().signal.addEventListener("abort", () => {
      setImmediate(() => { settled = true; resolve(); });
    }, { once: true }));
    return [];
  };
  const config = { ...aaveL.CHAINS[1], deployBlock: 1 };
  const index = aaveL.emptyIndex(config);
  await assert.rejects(deadline.run(() => aaveL.backfillParallel(index, {
    rpc: "https://mock.invalid", config, finalized: 3, chunkSize: 1, concurrency: 2, indexPath: "mock-index.json",
    fsImpl: { mkdirSync() {}, writeFileSync() { writes += 1; } },
  }), 10, { clock: () => now }), code("TIMEOUT"));
  assert.equal(starts, 2);
  assert.equal(settled, true);
  assert.equal(index.chunkReads, 0);
  assert.equal(index.failures, 0);
  assert.equal(index.cursor, 1);
  assert.deepEqual(index.backfill.done, []);
  assert.equal(writes, 0);
});

test("Aave backfill ordinary failure waits for sibling before recording failure", async () => {
  let settled = false;
  let writes = 0;
  transport = async (_rpc, method, [filter]) => {
    assert.equal(method, "eth_getLogs");
    if (filter.fromBlock === "0x1") throw new Error("MOCK_FAILURE");
    await tick(); settled = true; return [];
  };
  const config = { ...aaveL.CHAINS[1], deployBlock: 1 };
  const index = aaveL.emptyIndex(config);
  await assert.rejects(aaveL.backfillParallel(index, {
    rpc: "https://mock.invalid", config, finalized: 2, chunkSize: 1, concurrency: 2, indexPath: "mock-index.json",
    fsImpl: { mkdirSync() {}, writeFileSync() { assert.equal(settled, true); writes += 1; } },
  }), code("BACKFILL_FAILURE"));
  assert.equal(writes, 1);
});

for (const [name, scanner] of [["Morpho", morpho], ["Aave L", aaveL]]) {
  test(`${name} checkpoint checks immediately after serialization and before write`, async () => {
    let now = 0;
    let writes = 0;
    const index = { toJSON() { now = 11; return {}; } };
    await assert.rejects(deadline.run(() => scanner.persistIndex(index, "mock-index.json", {
      mkdirSync() {}, writeFileSync() { writes += 1; },
    }), 10, { clock: () => now }), code("TIMEOUT"));
    assert.equal(writes, 0);
  });
}

for (const [name, scanner] of [["Morpho", morpho], ["Aave L", aaveL], ["Aave O/F", aaveOf]]) {
  for (const phase of ["entry", "mkdir", "serialization", "first-write"]) {
    test(`${name} publication guards ${phase} expiry before the next write`, async () => {
      let now = 0;
      let writes = 0;
      let directories = 0;
      const artifact = { chainId: 1, toJSON() { if (phase === "serialization") now = 11; return {}; } };
      const input = name === "Aave O/F" ? { artifact, binder: {}, config: aaveOf.CHAINS[1], triggerClass: "O" } : artifact;
      await assert.rejects(deadline.run(() => {
        if (phase === "entry") now = 11;
        return scanner.publish(input, { fsImpl: {
          mkdirSync() { directories += 1; if (phase === "mkdir") now = 11; },
          writeFileSync() { writes += 1; if (phase === "first-write") now = 11; },
        } });
      }, 10, { clock: () => now }), code("TIMEOUT"));
      assert.equal(writes, phase === "first-write" ? 1 : 0);
      if (phase === "entry") assert.equal(directories, 0);
    });
  }
}
