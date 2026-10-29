#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");
const diagnostic = require("./diagnose-etherfi-qualification");
const producer = require("./run-critical-etherfi-debtmanager-profit-trigger");
const { REVIEWED_PROVIDER_FAMILY_IDS } = require("./lib/rpc-provider-reliability");

const NOW = 1800000000000;
const SOURCE = fs.readFileSync(path.join(__dirname, "run-critical-etherfi-debtmanager-profit-trigger.js"));
const EXPECTED_SHA = "e0c15152e462736a30d2707159622f965f15298de78012d34c182ae29a1810df";
const quantity = (value) => `0x${BigInt(value).toString(16)}`;
function header(overrides = {}) {
  return {
    number: quantity(149700000), timestamp: quantity(NOW / 1000), hash: `0x${"ab".repeat(32)}`,
    parentHash: `0x${"cd".repeat(32)}`, stateRoot: `0x${"ef".repeat(32)}`, ...overrides
  };
}
function candidate(index, operatorFamily = REVIEWED_PROVIDER_FAMILY_IDS[index], overrides = {}) {
  return { handle: `https://fixture-${index}.invalid/fake-secret-marker`, operatorFamily,
    inventoryOrder: index, capabilityRank: 1, ...overrides };
}
function safe(result) {
  assert.equal(diagnostic.validateResult(result), true);
  const json = JSON.stringify(result);
  assert.equal(/https?:|wss?:|fixture-|fake-secret-marker|injected-secret|api[_-]?key|authorization|bearer|\.invalid|\.example/i.test(json), false);
  assert.equal(REVIEWED_PROVIDER_FAMILY_IDS.some((family) => json.includes(family)), false);
  assert.equal(/profit|ready|POSITIVE_FLOW|PIN_CONSENSUS_UNAVAILABLE/i.test(json), false);
  assert.deepEqual(structuredClone(result.safety), {
    pinConsensusPerformed: false, stateReads: 0, flowReads: 0,
    monitorPublished: false, noSigning: true, noBroadcast: true
  });
  return result;
}
async function run(options = {}, responder = (_handle, method) => method === "eth_chainId" ? "0xa" : header()) {
  const calls = [];
  const result = await diagnostic.diagnoseQualification({
    candidates: [candidate(0), candidate(1), candidate(2)], now: () => NOW,
    rpcCall: async (handle, method, params, timeout) => {
      calls.push({ handle, method, params: structuredClone(params), timeout });
      assert.ok(method === "eth_chainId" || method === "eth_getBlockByNumber");
      assert.deepEqual(params, method === "eth_chainId" ? [] : ["finalized", false]);
      assert.equal(timeout, method === "eth_chainId" ? 3500 : 6000);
      return responder(handle, method, params, calls.length);
    },
    ...options
  });
  safe(result);
  assert.equal(result.networkCalls, calls.length);
  assert.equal(result.sourceSha256, EXPECTED_SHA);
  return { result, calls };
}
async function captureMain(argv, options) {
  const original = process.stdout.write;
  let stdout = "";
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  try { return { result: await diagnostic.main(argv, options), stdout: () => stdout }; }
  finally { process.stdout.write = original; }
}

test("no-argument CLI refuses before source, inventory, or RPC and prints only sanitized JSON", async () => {
  let touched = 0;
  const { result, stdout } = await captureMain([], {
    readSource: () => { touched += 1; throw new Error("injected-secret"); },
    inventoryLoader: () => { touched += 1; return []; }, rpcCall: () => { touched += 1; }
  });
  assert.equal(touched, 0);
  assert.equal(result.status, "REFUSED_ARGUMENTS");
  assert.equal(result.sourceSha256, null);
  safe(JSON.parse(stdout()));
  const cli = spawnSync(process.execPath, [path.join(__dirname, "diagnose-etherfi-qualification.js")], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, "");
  assert.equal(safe(JSON.parse(cli.stdout)).status, "REFUSED_ARGUMENTS");
});

test("CLI accepts exactly --run, rejecting extra arguments before any work", async () => {
  for (const argv of [["--run", "--run"], ["--run=true"], ["--help"], ["--run", "extra"]]) {
    const captured = await captureMain(argv, { rpcCall: () => assert.fail("RPC must not run") });
    assert.equal(safe(JSON.parse(captured.stdout())).status, "REFUSED_ARGUMENTS");
  }
  const captured = await captureMain(["--run"], {
    candidates: [candidate(0), candidate(1)], now: () => NOW,
    rpcCall: async (_handle, method) => method === "eth_chainId" ? "0xa" : header()
  });
  assert.equal(safe(JSON.parse(captured.stdout())).status, "QUALIFICATION_ONLY_COMPLETE_NOT_PIN_CONSENSUS");
});

test("source version mismatch refuses before candidate pool or network", async () => {
  let inventory = 0, calls = 0, sourceReads = 0;
  const result = await diagnostic.diagnoseQualification({
    readSource: () => { sourceReads += 1; return Buffer.concat([SOURCE, Buffer.from("\n// changed")]); },
    inventoryLoader: () => { inventory += 1; return []; }, rpcCall: () => { calls += 1; }
  });
  safe(result);
  assert.equal(result.status, "SOURCE_VERSION_MISMATCH");
  assert.equal(result.sourceUnchanged, false);
  assert.notEqual(result.sourceSha256, EXPECTED_SHA);
  assert.equal(sourceReads, 1);
  assert.equal(inventory, 0);
  assert.equal(calls, 0);
});

test("unreadable source produces no exception detail and no inventory or RPC", async () => {
  const result = await diagnostic.diagnoseQualification({
    readSource: () => { throw new Error("https://fixture.invalid/injected-secret"); },
    inventoryLoader: () => assert.fail("inventory must not run"), rpcCall: () => assert.fail("RPC must not run")
  });
  assert.equal(safe(result).status, "SOURCE_VERSION_MISMATCH");
  assert.equal(result.sourceSha256, null);
});

test("source is rechecked before completion and a changed source invalidates qualified status", async () => {
  let sourceReads = 0;
  const { result } = await run({ readSource: () => ++sourceReads === 1 ? SOURCE : Buffer.from("changed") });
  assert.equal(sourceReads, 2);
  assert.equal(result.finalizedQualified, 2);
  assert.equal(result.status, "SOURCE_CHANGED");
  assert.equal(result.sourceUnchanged, false);
});

test("test-only selection overrides cannot reach the default live transport", async () => {
  for (const options of [{ candidates: [] }, { inventoryLoader: () => assert.fail("inventory") },
    { candidateUrls: [] }, { now: () => NOW }, { readSource: () => assert.fail("source") }]) {
    assert.equal(safe(await diagnostic.diagnoseQualification(options)).status, "INVALID_OPTIONS");
  }
});

test("wrong chain never tries its valid retained same-family alternative", async () => {
  const primary = candidate(0), alternate = candidate(1, primary.operatorFamily), independent = candidate(2, "infura");
  const { result, calls } = await run({ candidates: [primary, alternate, independent] },
    (handle, method) => method === "eth_chainId" ? handle === primary.handle ? "0x1" : "0xa" : header());
  assert.equal(result.status, "TWO_FAMILIES_UNAVAILABLE");
  assert.equal(result.qualificationAttempts, 2);
  assert.equal(result.finalizedQualified, 1);
  assert.equal(result.counts.WRONG_CHAIN, 1);
  assert.equal(result.automaticRetries, 0);
  assert.equal(calls.some((call) => call.handle === alternate.handle), false);
  assert.deepEqual(result.attempts, [
    { attemptOrdinal: 1, stage: "CHAIN", outcome: "WRONG_CHAIN" },
    { attemptOrdinal: 2, stage: "FINALIZED", outcome: "FINALIZED_QUALIFIED" }
  ]);
});

test("chain conversion preserves producer BigInt semantics", async () => {
  for (const value of ["0xa", "10", 10, 10n, " 10 "]) {
    const { result } = await run({}, (_handle, method) => method === "eth_chainId" ? value : header());
    assert.equal(result.finalizedQualified, 2);
  }
  const { result } = await run({}, (_handle, method) => method === "eth_chainId" ? "malformed-injected-secret" : header());
  assert.equal(result.counts.INVALID_CHAIN_RESPONSE, 3);
  assert.equal(result.networkCalls, 3);
  assert.equal(result.chainMatches, 0);
});

test("missing, empty, malformed, and coerced non-quantity chain replies are invalid, not wrong-chain", async () => {
  for (const value of [null, undefined, "", " ", "malformed-injected-secret", "0x", "0xgg", "0x01",
    false, true, 0, 1, 1n, "1", [], {}]) {
    const { result, calls } = await run({}, (_handle, method) => method === "eth_chainId" ? value : header());
    assert.equal(result.counts.INVALID_CHAIN_RESPONSE, 3);
    assert.equal(result.counts.WRONG_CHAIN, 0);
    assert.equal(result.chainMatches, 0);
    assert.equal(result.finalizedQualified, 0);
    assert.equal(result.automaticRetries, 0);
    assert.equal(calls.every((call) => call.method === "eth_chainId"), true);
  }
});

test("only valid nonmatching hex quantities are attributed as wrong-chain", async () => {
  for (const value of ["0x0", "0x1", "0xb", "0xFF"]) {
    const { result } = await run({}, (_handle, method) => method === "eth_chainId" ? value : header());
    assert.equal(result.counts.WRONG_CHAIN, 3);
    assert.equal(result.counts.INVALID_CHAIN_RESPONSE, 0);
    assert.equal(result.networkCalls, 3);
    assert.equal(result.automaticRetries, 0);
  }
});

test("classified chain transport failure rotates exactly once and retains active alternative", async () => {
  const primary = candidate(0), alternate = candidate(1, primary.operatorFamily), independent = candidate(2, "infura");
  const { result, calls } = await run({ candidates: [primary, alternate, independent] }, (handle, method) => {
    if (handle === primary.handle) throw Object.assign(new Error("https://fixture.invalid/injected-secret"), { code: "RPC_TRANSPORT" });
    return method === "eth_chainId" ? "0xa" : header();
  });
  assert.equal(result.status, "QUALIFICATION_ONLY_COMPLETE_NOT_PIN_CONSENSUS");
  assert.deepEqual(calls.map((call) => call.handle), [primary.handle, alternate.handle, alternate.handle, independent.handle, independent.handle]);
  assert.equal(result.transportFailures, 1);
  assert.equal(result.automaticRetries, 1);
  assert.equal(result.retryExhaustions, 0);
  assert.equal(result.counts.TRANSPORT_FAILURE, 0);
  assert.equal(result.counts.FINALIZED_QUALIFIED, 2);
});

test("retry budget is shared across chain and finalized stages of a family", async () => {
  const primary = candidate(0), alternate = candidate(1, primary.operatorFamily), independent = candidate(2, "infura");
  const { result, calls } = await run({ candidates: [primary, alternate, independent] }, (handle, method) => {
    if (handle === primary.handle || handle === alternate.handle && method !== "eth_chainId") {
      throw Object.assign(new Error("injected-secret"), { code: "RPC_TIMEOUT" });
    }
    return method === "eth_chainId" ? "0xa" : header();
  });
  assert.equal(result.transportFailures, 2);
  assert.equal(result.automaticRetries, 1);
  assert.equal(result.retryExhaustions, 1);
  assert.equal(result.counts.TRANSPORT_FAILURE, 1);
  assert.equal(result.attempts[0].stage, "FINALIZED");
  assert.equal(calls.filter((call) => call.handle === primary.handle).length, 1);
  assert.equal(calls.filter((call) => call.handle === alternate.handle).length, 2);
});

test("finalized transport retry rotates without requalifying chain or adding probes", async () => {
  const primary = candidate(0), alternate = candidate(1, primary.operatorFamily), independent = candidate(2, "infura");
  const { result, calls } = await run({ candidates: [primary, alternate, independent] }, (handle, method) => {
    if (handle === primary.handle && method === "eth_getBlockByNumber") throw { cause: { code: "ECONNRESET" } };
    return method === "eth_chainId" ? "0xa" : header();
  });
  assert.equal(result.finalizedQualified, 2);
  assert.equal(result.transportFailures, 1);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.filter((call) => call.handle === alternate.handle).map((call) => call.method), ["eth_getBlockByNumber"]);
});

test("exhausted transport retries remain anonymous logical transport failures", async () => {
  const { result } = await run({}, () => { throw Object.assign(new Error("https://fixture.invalid/injected-secret"), { code: "ENOTFOUND" }); });
  assert.equal(result.qualificationAttempts, 3);
  assert.equal(result.networkCalls, 6);
  assert.equal(result.transportFailures, 6);
  assert.equal(result.automaticRetries, 3);
  assert.equal(result.retryExhaustions, 3);
  assert.equal(result.counts.TRANSPORT_FAILURE, 3);
});

for (const [name, raw, expected] of [
  ["null", null, "INVALID_HEADER"],
  ["malformed number", header({ number: "bad-injected-secret" }), "INVALID_HEADER"],
  ["missing root", header({ stateRoot: undefined }), "INVALID_HEADER"],
  ["unsafe number", header({ number: quantity(BigInt(Number.MAX_SAFE_INTEGER) + 1n) }), "INVALID_HEADER"],
  ["malformed timestamp", header({ timestamp: "no" }), "INVALID_HEADER"],
  ["predeployment and stale", header({ number: quantity(149521227), timestamp: "0x2" }), "PREDEPLOYMENT_HEADER"],
  ["stale", header({ timestamp: quantity(NOW / 1000 - 86401) }), "STALE_HEADER"],
  ["future", header({ timestamp: quantity(NOW / 1000 + 301) }), "FUTURE_HEADER"]
]) {
  test(`${name} finalized header is classified ${expected} without extra calls`, async () => {
    const { result, calls } = await run({}, (_handle, method) => method === "eth_chainId" ? "0xa" : raw);
    assert.equal(result.status, "TWO_FAMILIES_UNAVAILABLE");
    assert.equal(result.counts[expected], 3);
    assert.equal(result.chainMatches, 3);
    assert.equal(calls.length, 6);
    assert.equal(result.automaticRetries, 0);
    assert.equal(result.attempts.every((attempt) => attempt.stage === "FINALIZED"), true);
  });
}

test("deployment, age, and future-skew exact boundaries are accepted", async () => {
  for (const overrides of [{ number: quantity(149521228) }, { timestamp: quantity(NOW / 1000 - 86400) },
    { timestamp: quantity(NOW / 1000 + 300) }]) {
    const { result } = await run({}, (_handle, method) => method === "eth_chainId" ? "0xa" : header(overrides));
    assert.equal(result.finalizedQualified, 2);
  }
});

test("two finalized-qualified families stop before third, even with disagreeing headers", async () => {
  const { result, calls } = await run({}, (handle, method) => method === "eth_chainId" ? "0xa"
    : header({ hash: `0x${handle === candidate(0).handle ? "11".repeat(32) : "22".repeat(32)}` }));
  assert.equal(result.status, "QUALIFICATION_ONLY_COMPLETE_NOT_PIN_CONSENSUS");
  assert.equal(result.qualificationAttempts, 2);
  assert.equal(calls.length, 4);
  assert.equal(calls.some((call) => call.handle === candidate(2).handle), false);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(JSON.stringify(result).includes("11111111"), false);
});

test("unknown and unreviewed families are skipped and cannot supply quorum", async () => {
  const { result, calls } = await run({ candidates: [candidate(0, "unknown"), candidate(1, "blastapi"), candidate(2, "alchemy")] });
  assert.equal(result.recognizedFamilyCount, 1);
  assert.equal(result.qualificationAttempts, 0);
  assert.equal(result.status, "TWO_FAMILIES_UNAVAILABLE");
  assert.equal(calls.length, 0);
  const mixed = await run({ candidates: [candidate(0, "unknown"), candidate(1), candidate(2)] });
  assert.equal(mixed.result.selectedCandidateRows, 3);
  assert.equal(mixed.calls.some((call) => call.handle === candidate(0).handle), false);
});

test("selection preserves producer ranking, deduplication, family cap, and 44-row cap", async () => {
  const candidates = [
    ...Array.from({ length: 55 }, (_, index) => candidate(index + 20, "unknown")),
    candidate(0, "alchemy", { capabilityRank: 0 }), candidate(1, "infura", { capabilityRank: 0 }),
    candidate(2, "alchemy", { capabilityRank: 0 }), candidate(3, "alchemy", { capabilityRank: 0 }), candidate(0, "alchemy")
  ];
  const expected = producer.candidatePool({ candidates });
  const { result, calls } = await run({ candidates });
  assert.equal(result.selectedCandidateRows, 44);
  assert.equal(result.recognizedFamilyCount, 2);
  assert.equal(expected.filter((row) => row.operatorFamily === "alchemy").length, 2);
  assert.deepEqual(calls.filter((call) => call.method === "eth_chainId").map((call) => call.handle), expected.slice(0, 2).map((row) => row.handle));
});

test("default inventory path uses exactly producer fallback and hostname-hint ordering", async () => {
  const hinted = "https://node.optimism.alchemy.com/fake-secret-marker";
  const inventory = ["https://ordinary.alchemy.com/fake-secret-marker", hinted, "https://optimism.infura.io/fake-secret-marker",
    ...Array.from({ length: 50 }, (_, index) => candidate(index + 20, null).handle)];
  const expected = producer.candidatePool({ inventoryLoader: () => inventory });
  const calls = [];
  let loads = 0;
  const result = await diagnostic.diagnoseQualification({
    inventoryLoader: (options) => { loads += 1; assert.deepEqual(options, { maxCandidates: 96 }); return inventory; },
    now: () => NOW, rpcCall: async (handle, method) => { calls.push({ handle, method }); return method === "eth_chainId" ? "0xa" : header(); }
  });
  safe(result);
  assert.equal(loads, 1);
  assert.equal(result.selectedCandidateRows, expected.length);
  const families = new Set();
  const expectedHandles = expected.filter((row) => {
    if (!row.operatorFamily || families.has(row.operatorFamily)) return false;
    families.add(row.operatorFamily); return true;
  }).slice(0, 2).map((row) => row.handle);
  assert.deepEqual(calls.filter((call) => call.method === "eth_chainId").map((call) => call.handle), expectedHandles);
});

test("RPC exceptions never serialize codes, messages, URLs, tokens, or bodies and do not rotate", async () => {
  for (const stage of ["CHAIN", "FINALIZED"]) {
    const { result } = await run({}, (_handle, method) => {
      if (stage === "CHAIN" || method !== "eth_chainId") {
        throw Object.assign(new Error("https://fixture.invalid/injected-secret Bearer injected-secret"), {
          code: "RAW_ERROR_injected-secret", body: { token: "injected-secret" }
        });
      }
      return "0xa";
    });
    assert.equal(result.counts.RPC_FAILURE, 3);
    assert.equal(result.automaticRetries, 0);
    assert.equal(result.attempts.every((attempt) => attempt.stage === stage), true);
  }
});

test("inventory exceptions are controlled and source is still rechecked", async () => {
  let sourceReads = 0;
  const { result, calls } = await run({ candidates: undefined,
    readSource: () => { sourceReads += 1; return SOURCE; },
    inventoryLoader: () => { throw new Error("https://fixture.invalid/injected-secret"); }
  });
  assert.equal(result.status, "INVENTORY_FAILURE");
  assert.equal(sourceReads, 2);
  assert.equal(calls.length, 0);
});

test("raw transport allowlist rejects every state/log/write/exact-height path before invocation", async () => {
  let calls = 0;
  const guard = diagnostic.createQualificationTransport(async () => { calls += 1; return null; });
  for (const [method, params, timeout] of [
    ["eth_getLogs", [], 6000], ["eth_getCode", [], 6000], ["eth_getStorageAt", [], 6000], ["eth_call", [], 6000],
    ["eth_sendRawTransaction", [], 6000], ["eth_sendTransaction", [], 6000], ["personal_sign", [], 3500],
    ["eth_getBlockByNumber", ["latest", false], 6000], ["eth_getBlockByNumber", ["0x123", false], 6000],
    ["eth_getBlockByNumber", ["finalized", true], 6000], ["eth_chainId", ["extra"], 3500],
    ["eth_chainId", [], 6000], ["eth_getBlockByNumber", ["finalized", false], 3500]
  ]) await assert.rejects(guard("fake-handle", method, params, timeout), { message: "METHOD_REJECTED" });
  assert.equal(calls, 0);
  await guard("fake-handle", "eth_chainId", [], 3500);
  await guard("fake-handle", "eth_getBlockByNumber", ["finalized", false], 6000);
  assert.equal(calls, 2);
});

// Exercise otherwise unreachable reserve boundaries without adding live selection/limit overrides.
function withLedgerOffset(offset) {
  const module = { exports: {} };
  const common = require("./lib/common-finalized-rpc-preflight");
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "diagnose-etherfi-qualification.js"), "utf8"), {
    module, __dirname, process, Buffer,
    require: (name) => name === "./lib/common-finalized-rpc-preflight" ? {
      ...common,
      createRpcLedger: (raw, maximum) => {
        let networkCalls = offset;
        return { get networkCalls() { return networkCalls; }, maxNetworkCalls: maximum,
          call: (...args) => { networkCalls += 1; return raw(...args); } };
      }
    } : require(name)
  });
  return module.exports;
}

test("reserve boundary stops before family attempt at remaining <=26", async () => {
  const bounded = withLedgerOffset(39);
  let calls = 0;
  const result = await bounded.diagnoseQualification({ candidates: [candidate(0), candidate(1)], now: () => NOW,
    rpcCall: async () => { calls += 1; } });
  safe(result);
  assert.equal(result.status, "NETWORK_CALL_CAP");
  assert.equal(result.qualificationAttempts, 0);
  assert.equal(calls, 0);
});

test("remaining 27 permits one attempt including original one-retry crossing behavior", async () => {
  const bounded = withLedgerOffset(38);
  let calls = 0;
  const result = await bounded.diagnoseQualification({ candidates: [candidate(0), candidate(1)], now: () => NOW,
    rpcCall: async (_handle, method) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("injected-secret"), { code: "RPC_TIMEOUT" });
      return method === "eth_chainId" ? "0xa" : header();
    } });
  safe(result);
  assert.equal(result.status, "NETWORK_CALL_CAP");
  assert.equal(result.qualificationAttempts, 1);
  assert.equal(result.finalizedQualified, 1);
  assert.equal(result.networkCalls, 41);
  assert.equal(result.automaticRetries, 1);
  assert.equal(calls, 3);
});

test("worst reviewed-family retry path remains under the fixed read budget", async () => {
  const { result } = await run({ candidates: REVIEWED_PROVIDER_FAMILY_IDS.map((family, index) => candidate(index, family)) },
    (_handle, method) => {
      if (method === "eth_chainId") return "0xa";
      throw Object.assign(new Error("injected-secret"), { code: "RPC_TIMEOUT" });
    });
  assert.equal(result.networkCalls, 24);
  assert.equal(result.qualificationAttempts, 8);
  assert.equal(result.automaticRetries, 8);
  assert.ok(result.networkCalls < 39);
  assert.deepEqual([result.limits.maxCandidates, result.limits.maxNetworkCalls, result.limits.preflightCeiling, result.limits.probeReserve], [44, 80, 65, 26]);
});

test("output allowlist rejects extra fields, arbitrary enums, raw material, and safety inflation", async () => {
  const { result } = await run();
  for (const mutate of [
    (value) => { value.raw = "injected-secret"; },
    (value) => { value.status = "READY"; },
    (value) => { value.attempts[0].outcome = "injected-secret"; },
    (value) => { value.attempts[0].handle = "https://fixture.invalid/injected-secret"; },
    (value) => { value.safety.pinConsensusPerformed = true; },
    (value) => { value.safety.stateReads = 1; },
    (value) => { value.sourceSha256 = "https://fixture.invalid/injected-secret"; },
    (value) => { value.counts.FINALIZED_QUALIFIED = 1; },
    (value) => { value.networkCalls = 81; },
    (value) => { value.limits.maxCandidates = 96; }
  ]) {
    const changed = structuredClone(result);
    mutate(changed);
    assert.equal(diagnostic.validateResult(changed), false);
  }
});
