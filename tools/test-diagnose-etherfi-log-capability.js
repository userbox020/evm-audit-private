"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const diagnostic = require("./diagnose-etherfi-log-capability");
const producer = require("./run-critical-etherfi-debtmanager-profit-trigger");
const common = require("./lib/common-finalized-rpc-preflight");
const { REVIEWED_PROVIDER_FAMILY_IDS } = require("./lib/rpc-provider-reliability");

const NOW = 1800000000000, HEIGHT = 149700000, DEPLOYMENT = 149521228;
const SOURCE = fs.readFileSync(path.join(__dirname, "run-critical-etherfi-debtmanager-profit-trigger.js"));
const A = "https://fixture-a.invalid/dummy-secret", B = "https://fixture-b.invalid/dummy-secret", C = "https://fixture-c.invalid/dummy-secret";
const candidates = [A, B, C].map((handle, index) => ({ handle, operatorFamily: REVIEWED_PROVIDER_FAMILY_IDS[index] }));
function header(number = HEIGHT, overrides = {}) {
  return { number: ethers.toQuantity(number), hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"cd".repeat(32)}`,
    stateRoot: `0x${"ef".repeat(32)}`, timestamp: ethers.toQuantity(NOW / 1000), ...overrides };
}
function fixture(overrides = {}) { return { chain: "0xa", finalized: header(), logs: [], ...overrides }; }
function safe(result, api = diagnostic) {
  assert.equal(api.validateResult(result), true);
  const text = JSON.stringify(result);
  assert.equal(/https?:|wss?:|\.invalid|fixture-|dummy-secret|injected-secret|event-secret|authorization|bearer/i.test(text), false);
  assert.equal(REVIEWED_PROVIDER_FAMILY_IDS.some((family) => text.includes(family)), false);
  assert.equal(/\bREADY\b|profit|economics|available|blockHash|transactionHash|eventData/i.test(text), false);
  assert.deepEqual(structuredClone(result.safety), { pinConsensusPerformed: false, logsCapableProbe: true, noSigning: true, noBroadcast: true });
  return result;
}
async function run(rows = [fixture(), fixture()], options = {}, api = diagnostic) {
  const calls = [];
  const result = await api.diagnoseLogCapability({ candidates, now: () => NOW, readSource: () => SOURCE,
    rpcCall: async (handle, method, params, timeout) => {
      calls.push({ handle, method, params: structuredClone(params), timeout });
      const index = [A, B].indexOf(handle); assert.ok(index >= 0, "no other endpoint may be contacted");
      const row = rows[index];
      if (row.intercept) row.intercept(method, params);
      if (method === "eth_chainId") { assert.deepEqual(structuredClone(params), []); assert.equal(timeout, 3500); return row.chain; }
      if (method === "eth_getBlockByNumber") { assert.deepEqual(structuredClone(params), ["finalized", false]); assert.equal(timeout, 6000); return row.finalized; }
      assert.equal(method, "eth_getLogs"); assert.equal(timeout, 10000);
      const height = Number(BigInt(row.finalized.number)), from = Math.max(DEPLOYMENT, height - 100000 + 1), to = Math.min(height, from + 49999);
      assert.deepEqual(structuredClone(params), [{ address: producer.MANAGER, fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to), topics: [producer.SUPPLIED_TOPIC] }]);
      return row.logs;
    }, ...options });
  safe(result, api);
  assert.equal(result.perMember.reduce((sum, member) => sum + member.reads, 0), calls.length);
  assert.ok(calls.length <= 80);
  return { result, calls };
}

test("both members log-capable: exact producer-parity chunk, one probe each and six reads total", async () => {
  for (const heights of [[HEIGHT, HEIGHT + 1], [DEPLOYMENT, DEPLOYMENT + 13], [DEPLOYMENT + 49999, DEPLOYMENT + 100000]]) {
    const { result, calls } = await run(heights.map((height) => fixture({ finalized: header(height) })));
    assert.equal(result.status, "TWO_FAMILY_LOG_CAPABLE");
    assert.equal(result.sourceUnchanged, true);
    assert.equal(result.capableFamilies, 2);
    assert.equal(calls.length, 6);
    assert.equal(calls.filter((call) => call.method === "eth_getLogs").length, 2);
    assert.equal(result.counts.LOG_CAPABLE, 2);
    assert.match(result.sharedRpcSha256, /^[0-9a-f]{64}$/);
    for (let index = 0; index < 2; index += 1) {
      const from = Math.max(DEPLOYMENT, heights[index] - 99999), to = Math.min(heights[index], from + 49999);
      assert.deepEqual(result.perMember[index].lastWindow, { fromBlock: String(from), toBlock: String(to) });
      assert.equal(result.perMember[index].reads, 3);
    }
  }
});

test("exactly one capable family remains a partial capability result", async () => {
  const { result } = await run([fixture({ logs: null }), fixture()]);
  assert.equal(result.status, "ONE_FAMILY_LOG_CAPABLE");
  assert.equal(result.capableFamilies, 1);
  assert.equal(result.counts.INVALID_LOG_RESPONSE, 1);
  assert.equal(result.perMember[0].capable, false);
});

test("zero capable families report the first member failure rather than claiming general availability", async () => {
  const { result } = await run([fixture({ chain: "0x1" }), fixture({ logs: null })]);
  assert.equal(result.status, "CHAIN_MISMATCH");
  assert.equal(result.capableFamilies, 0);
  assert.equal(result.counts.CHAIN_MISMATCH, 1);
  assert.equal(result.counts.INVALID_LOG_RESPONSE, 1);
});

test("chain mismatch skips only its own remaining stages and never rotates", async () => {
  const { result, calls } = await run([fixture({ chain: "0x1" }), fixture()]);
  assert.equal(result.perMember[0].stageChain, "CHAIN_MISMATCH");
  assert.equal(result.perMember[0].stageLog, "NOT_RUN");
  assert.equal(result.perMember[0].lastWindow, null);
  assert.equal(result.perMember[0].reads, 1);
  assert.deepEqual(calls.filter((call) => call.handle === A).map((call) => call.method), ["eth_chainId"]);
  assert.equal(result.perMember[1].capable, true);
});

test("non-quantity chain replies are CHAIN_INVALID, never attributed to another chain", async () => {
  for (const chain of [null, undefined, "", " ", "0x01", "0xgg", "10", 10, false, {}, []]) {
    const { result } = await run([fixture({ chain }), fixture({ chain })]);
    assert.equal(result.status, "CHAIN_INVALID");
    assert.equal(result.counts.CHAIN_INVALID, 2);
    assert.equal(result.perMember.every((row) => row.reads === 1 && row.stageLog === "NOT_RUN"), true);
  }
});

test("finalized stale/future/predeployment/malformed replies are categorical and skip logs", async () => {
  for (const [finalized, outcome] of [
    [header(HEIGHT, { timestamp: ethers.toQuantity(NOW / 1000 - 86401) }), "STALE_HEADER"],
    [header(HEIGHT, { timestamp: ethers.toQuantity(NOW / 1000 + 301) }), "FUTURE_HEADER"],
    [header(DEPLOYMENT - 1), "PREDEPLOYMENT_HEADER"], [null, "FINALIZED_INVALID"],
    [header(HEIGHT, { stateRoot: "injected-secret" }), "FINALIZED_INVALID"]
  ]) {
    const { result, calls } = await run([fixture({ finalized }), fixture({ finalized })]);
    assert.equal(result.status, outcome);
    assert.equal(result.counts[outcome], 2);
    assert.equal(calls.some((call) => call.method === "eth_getLogs"), false);
    assert.equal(result.perMember.every((row) => row.reads === 2), true);
  }
});

test("exact age and future-skew boundaries are accepted", async () => {
  const { result } = await run([fixture({ finalized: header(HEIGHT, { timestamp: ethers.toQuantity(NOW / 1000 - 86400) }) }),
    fixture({ finalized: header(HEIGHT, { timestamp: ethers.toQuantity(NOW / 1000 + 300) }) })]);
  assert.equal(result.status, "TWO_FAMILY_LOG_CAPABLE");
});

test("every non-array log response is invalid; no logsCount is fabricated", async () => {
  for (const logs of [null, undefined, {}, "[]", "injected-secret", false, 0]) {
    const { result } = await run([fixture({ logs }), fixture({ logs })]);
    assert.equal(result.status, "INVALID_LOG_RESPONSE");
    assert.equal(result.counts.INVALID_LOG_RESPONSE, 2);
    assert.equal(Object.hasOwn(result.perMember[0], "logsCount"), false);
  }
});

test("arrays expose only numeric lengths, never event objects, hashes or raw log contents", async () => {
  const logs = [{ address: A, eventData: "event-secret", transactionHash: `0x${"12".repeat(32)}` }, "event-secret"];
  const { result } = await run([fixture({ logs }), fixture({ logs: [] })]);
  assert.equal(result.perMember[0].logsCount, 2);
  assert.equal(result.perMember[1].logsCount, 0);
  assert.equal(result.status, "TWO_FAMILY_LOG_CAPABLE");
});

test("classified transport and generic RPC errors remain distinct without retries or raw exception leakage", async () => {
  for (const transport of [true, false]) for (const stage of ["eth_chainId", "eth_getBlockByNumber", "eth_getLogs"]) {
    const row = fixture({ intercept: (method) => {
      if (method === stage) throw Object.assign(new Error("https://fixture.invalid/injected-secret Bearer injected-secret"),
        { code: transport ? "RPC_TIMEOUT" : "injected-secret", headers: { authorization: "injected-secret" }, body: "injected-secret" });
    } });
    const { result, calls } = await run([row, row]);
    const outcome = transport ? "TRANSPORT_FAILURE" : "RPC_FAILURE";
    assert.equal(result.status, outcome);
    assert.equal(result.counts[outcome], 2);
    assert.equal(calls.filter((call) => call.handle === A && call.method === stage).length, 1);
  }
});

function isolated(overrides = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "diagnose-etherfi-log-capability.js"), "utf8"), {
    module, __dirname, process, Buffer,
    require: (name) => name === "./lib/common-finalized-rpc-preflight" ? { ...common, ...overrides.common }
      : name === "./run-critical-etherfi-debtmanager-profit-trigger" ? overrides.producer || producer : require(name)
  }); return module.exports;
}
test("network cap stops further calls and takes precedence over an earlier member failure", async () => {
  const api = isolated({ common: { createRpcLedger: (raw, maximum) => {
    const ledger = common.createRpcLedger(raw, maximum);
    return { get networkCalls() { return ledger.networkCalls; }, call: (handle, method, ...args) => {
      if (handle === B && method === "eth_getLogs") throw new common.PreflightError("NETWORK_CALL_CAP");
      return ledger.call(handle, method, ...args);
    } };
  } } });
  const { result, calls } = await run([fixture({ logs: null }), fixture()], {}, api);
  assert.equal(result.status, "NETWORK_CALL_CAP");
  assert.equal(result.counts.INVALID_LOG_RESPONSE, 1);
  assert.equal(result.counts.NETWORK_CALL_CAP, 1);
  assert.equal(calls.length, 5);
  assert.equal(result.perMember[1].reads, 2);
  const stopped = isolated({ common: { createRpcLedger: () => ({ networkCalls: 0,
    call: async () => { throw new common.PreflightError("NETWORK_CALL_CAP"); } }) } });
  const empty = await run(undefined, {}, stopped);
  assert.equal(empty.result.status, "NETWORK_CALL_CAP");
  assert.equal(empty.calls.length, 0);
});

test("CLI refuses all but exact --run before source/inventory/network and prints only sanitized JSON", async () => {
  async function main(argv, options) {
    const original = process.stdout.write; let stdout = "";
    process.stdout.write = (value) => { stdout += value; return true; };
    try { await diagnostic.main(argv, options); return safe(JSON.parse(stdout)); } finally { process.stdout.write = original; }
  }
  const refused = { readSource: () => assert.fail("source"), inventoryLoader: () => assert.fail("inventory"), rpcCall: () => assert.fail("network") };
  for (const args of [[], ["--help"], ["--run=true"], ["--run", "extra"], ["--run", "--run"]]) {
    assert.equal((await main(args, refused)).status, "REFUSED_ARGUMENTS");
  }
  const result = await main(["--run"], { candidates, now: () => NOW, readSource: () => SOURCE,
    rpcCall: async (_handle, method) => method === "eth_chainId" ? "0xa" : method === "eth_getBlockByNumber" ? header() : [] });
  assert.equal(result.status, "TWO_FAMILY_LOG_CAPABLE");
  const cli = spawnSync(process.execPath, [path.join(__dirname, "diagnose-etherfi-log-capability.js")], { encoding: "utf8" });
  assert.equal(cli.status, 1); assert.equal(cli.stderr, ""); assert.equal(safe(JSON.parse(cli.stdout)).status, "REFUSED_ARGUMENTS");
});

test("source guard refuses before inventory/network; completion source change invalidates capability success", async () => {
  for (const readSource of [() => Buffer.from("changed"), () => { throw new Error("injected-secret"); }]) {
    const result = await diagnostic.diagnoseLogCapability({ readSource,
      inventoryLoader: () => assert.fail("inventory"), rpcCall: () => assert.fail("network") });
    assert.equal(safe(result).status, "SOURCE_VERSION_MISMATCH");
  }
  let reads = 0;
  const { result } = await run(undefined, { readSource: () => ++reads === 1 ? SOURCE : Buffer.from("changed") });
  assert.equal(reads, 2); assert.equal(result.status, "SOURCE_CHANGED");
  assert.equal(result.sourceUnchanged, false); assert.equal(result.capableFamilies, 2);
});

test("selection injections require explicit raw transport and reject extra options or invalid types", async () => {
  for (const options of [null, [], { candidates: [] }, { now: () => NOW }, { inventoryLoader: () => assert.fail() },
    { readSource: () => assert.fail() }, { rpcCall: null }, { candidateUrls: [] }, { maxNetworkCalls: 100 },
    { rpcCall: () => assert.fail(), candidates: null }, { rpcCall: () => assert.fail(), now: null }]) {
    assert.equal(safe(await diagnostic.diagnoseLogCapability(options)).status, "INVALID_OPTIONS");
  }
});

test("pool order selects first distinct reviewed families only; fewer than two refuses pre-network", async () => {
  const { result } = await run(undefined, { candidates: [{ handle: C, operatorFamily: "unknown" }, candidates[0],
    { handle: C, operatorFamily: candidates[0].operatorFamily }, candidates[1], candidates[2]] });
  assert.equal(result.status, "TWO_FAMILY_LOG_CAPABLE");
  const insufficient = await run(undefined, { candidates: [candidates[0]] });
  assert.equal(insufficient.result.status, "INSUFFICIENT_FAMILIES"); assert.equal(insufficient.calls.length, 0);
});

test("inventory test seam forwards only its loader and never uses supplied candidates as a new ranked pool", async () => {
  let loads = 0;
  const api = isolated({ producer: { ...producer, candidatePool: (options) => {
    assert.deepEqual(Object.keys(options), ["inventoryLoader"]); options.inventoryLoader(); return candidates;
  } } });
  const { result } = await run(undefined, { candidates: undefined,
    inventoryLoader: () => { loads += 1; return []; } }, api);
  assert.equal(result.status, "INVALID_OPTIONS"); // Present undefined candidates are invalid, not a silent fallback.
  const calls = [];
  const actual = await api.diagnoseLogCapability({ now: () => NOW, readSource: () => SOURCE,
    inventoryLoader: () => { loads += 1; return []; }, rpcCall: async (handle, method) => {
      calls.push(handle); return method === "eth_chainId" ? "0xa" : method === "eth_getBlockByNumber" ? header() : [];
    } });
  assert.equal(safe(actual, api).status, "TWO_FAMILY_LOG_CAPABLE"); assert.equal(loads, 1); assert.equal(calls.length, 6);
});

test("transport exact allowlist blocks other methods, addresses, topics, malformed or oversized ranges before raw", async () => {
  let calls = 0;
  const guard = diagnostic.createLogTransport(async () => { calls += 1; return []; });
  const filter = { address: producer.MANAGER, fromBlock: ethers.toQuantity(DEPLOYMENT), toBlock: ethers.toQuantity(DEPLOYMENT + 49999), topics: [producer.SUPPLIED_TOPIC] };
  for (const [method, params, timeout] of [
    ...["eth_call", "eth_getCode", "eth_getStorageAt", "eth_sendRawTransaction", "eth_sendTransaction", "personal_sign", "debug_traceCall"].map((method) => [method, [], 10000]),
    ["eth_chainId", [1], 3500], ["eth_getBlockByNumber", ["latest", false], 6000], ["eth_getBlockByNumber", ["0x1", false], 6000],
    ["eth_getLogs", null, 10000], ["eth_getLogs", [filter], 6000],
    ...[{ address: ethers.ZeroAddress }, { topics: [] }, { topics: [[producer.SUPPLIED_TOPIC]] }, { topics: [producer.SUPPLIED_TOPIC, null] },
      { fromBlock: "latest" }, { fromBlock: "0x01" }, { fromBlock: "0x1" }, { toBlock: ethers.toQuantity(DEPLOYMENT - 1) },
      { toBlock: ethers.toQuantity(DEPLOYMENT + 50000) }, { blockHash: header().hash }].map((change) => ["eth_getLogs", [{ ...filter, ...change }], 10000])
  ]) await assert.rejects(guard("synthetic", method, params, timeout), { message: "METHOD_REJECTED" });
  assert.equal(calls, 0);
  await guard("synthetic", "eth_chainId", [], 3500);
  await guard("synthetic", "eth_getBlockByNumber", ["finalized", false], 6000);
  await guard("synthetic", "eth_getLogs", [filter], 10000);
  assert.equal(calls, 3);
});

test("validator exact keys, stage/count consistency and safety reject identities and inflated output", async () => {
  const { result } = await run();
  for (const mutate of [
    (x) => { x.raw = "injected-secret"; }, (x) => { x.status = "READY"; }, (x) => { x.counts.LOG_CAPABLE = 1; },
    (x) => { x.capableFamilies = 3; }, (x) => { x.sourceUnchanged = false; }, (x) => { x.safety.pinConsensusPerformed = true; },
    (x) => { x.perMember[0].handle = A; }, (x) => { x.perMember[0].logsCount = "event-secret"; },
    (x) => { x.perMember[0].reads = 4; }, (x) => { x.perMember[0].stageChain = "CHAIN_INVALID"; },
    (x) => { x.perMember[0].lastWindow.fromBlock = A; }, (x) => { x.perMember[0].lastWindow.toBlock = "0"; },
    (x) => { x.limits.logChunk = 100000; }, (x) => { x.producerSourceSha256 = "0".repeat(64); }
  ]) { const changed = structuredClone(result); mutate(changed); assert.equal(diagnostic.validateResult(changed), false); }
});
