#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");
const retained = require("./diagnose-etherfi-retained-alternatives");
const diagnostic = require("./diagnose-etherfi-qualification");
const producer = require("./run-critical-etherfi-debtmanager-profit-trigger");
const { REVIEWED_PROVIDER_FAMILY_IDS } = require("./lib/rpc-provider-reliability");

const NOW = 1800000000000;
const SOURCE = fs.readFileSync(path.join(__dirname, "run-critical-etherfi-debtmanager-profit-trigger.js"));
const SHA = "e0c15152e462736a30d2707159622f965f15298de78012d34c182ae29a1810df";
const quantity = (value) => `0x${BigInt(value).toString(16)}`;
const A = "https://optimism.alchemy.com/primary-dummy-secret";
const AA = "https://optimism.alchemy.com/alternate-dummy-secret";
const A3 = "https://optimism.alchemy.com/excluded-dummy-secret";
const I = "https://optimism.infura.io/primary-dummy-secret";
const IA = "https://optimism.infura.io/alternate-dummy-secret";
const Q = "https://optimism.quicknode.com/primary-dummy-secret";
const QA = "https://optimism.quicknode.com/alternate-dummy-secret";
function header(overrides = {}) {
  return { number: quantity(149700000), timestamp: quantity(NOW / 1000),
    hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"cd".repeat(32)}`, stateRoot: `0x${"ef".repeat(32)}`, ...overrides };
}
function safe(result, api = retained) {
  assert.equal(api.validateResult(result), true);
  const json = JSON.stringify(result);
  assert.equal(/https?:|wss?:|dummy-secret|fixture-|injected-secret|api[_-]?key|authorization|bearer|\.invalid/i.test(json), false);
  assert.equal(REVIEWED_PROVIDER_FAMILY_IDS.some((family) => json.includes(family)), false);
  assert.equal(/profit|\bREADY\b|POSITIVE_FLOW/i.test(json), false);
  assert.deepEqual(structuredClone(result.safety), { sameSelectedPoolOnly: true,
    pinConsensusPerformed: false, stateReads: 0, flowReads: 0, monitorPublished: false, noSigning: true, noBroadcast: true });
  return result;
}
async function run({ inventory = [A, AA, I, IA], responder, options = {}, api = retained } = {}) {
  const calls = [];
  let loads = 0;
  const primary = new Set([A, I, Q]);
  const result = await api.diagnoseRetainedAlternatives({
    now: () => NOW,
    inventoryLoader: (limits) => { loads += 1; assert.deepEqual(structuredClone(limits), { maxCandidates: 96 }); return inventory; },
    rpcCall: async (handle, method, params, timeout) => {
      calls.push({ handle, method, params: structuredClone(params), timeout });
      assert.ok(["eth_chainId", "eth_getBlockByNumber"].includes(method));
      assert.deepEqual(structuredClone(params), method === "eth_chainId" ? [] : ["finalized", false]);
      assert.equal(timeout, method === "eth_chainId" ? 3500 : 6000);
      return responder ? responder(handle, method, calls.length)
        : method === "eth_chainId" ? primary.has(handle) ? "0x1" : "0xa" : header();
    }, ...options
  });
  safe(result, api);
  assert.equal(result.totalNetworkCalls, calls.length);
  return { result, calls, loads };
}
async function captureMain(argv, options) {
  const original = process.stdout.write;
  let stdout = "";
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  try { return { result: await retained.main(argv, options), stdout: () => stdout }; }
  finally { process.stdout.write = original; }
}

test("CLI refuses everything except exact --run before source/inventory/network", async () => {
  let touches = 0;
  const options = { readSource: () => { touches += 1; }, inventoryLoader: () => { touches += 1; }, rpcCall: () => { touches += 1; } };
  for (const args of [[], ["--help"], ["--run=true"], ["--run", "extra"], ["--run", "--run"]]) {
    const captured = await captureMain(args, options);
    assert.equal(safe(JSON.parse(captured.stdout())).status, "REFUSED_ARGUMENTS");
  }
  assert.equal(touches, 0);
  const cli = spawnSync(process.execPath, [path.join(__dirname, "diagnose-etherfi-retained-alternatives.js")], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, "");
  assert.equal(safe(JSON.parse(cli.stdout)).status, "REFUSED_ARGUMENTS");
});

test("explicit CLI run prints only validated sanitized JSON with injected offline transport", async () => {
  const captured = await captureMain(["--run"], { inventoryLoader: () => [A, AA], now: () => NOW,
    rpcCall: async (handle, method) => method === "eth_chainId" ? handle === A ? "0x1" : "0xa" : header() });
  assert.equal(safe(JSON.parse(captured.stdout())).status, "SECOND_FAMILY_FOUND_IN_EXISTING_POOL");
});

test("test overrides require explicit rpcCall and no candidates, URLs or cap options are accepted", async () => {
  for (const options of [null, [], { inventoryLoader: () => assert.fail() }, { now: () => NOW },
    { readSource: () => assert.fail() }, { rpcCall: null }, { candidates: [] }, { candidateUrls: [] },
    { maxNetworkCalls: 100 }, { rpcCall: async () => assert.fail(), maxCandidates: 44 },
    { rpcCall: async () => assert.fail(), inventoryLoader: null }]) {
    assert.equal(safe(await retained.diagnoseRetainedAlternatives(options)).status, "INVALID_OPTIONS");
  }
});

test("version guard and unreadable source refuse before inventory or transport without error details", async () => {
  for (const readSource of [() => Buffer.concat([SOURCE, Buffer.from("changed")]),
    () => { throw new Error("https://fixture.invalid/injected-secret"); }]) {
    const result = await retained.diagnoseRetainedAlternatives({ readSource,
      inventoryLoader: () => assert.fail("inventory"), rpcCall: () => assert.fail("network") });
    assert.equal(safe(result).status, "SOURCE_VERSION_MISMATCH");
    assert.equal(result.originalSourceSha, null);
  }
});

test("source change at completion invalidates otherwise successful alternatives", async () => {
  let reads = 0;
  const { result } = await run({ options: { readSource: () => ++reads < 4 ? SOURCE : Buffer.from("changed") } });
  assert.equal(reads, 4);
  assert.equal(result.qualifiedFamiliesAfter, 2);
  assert.equal(result.status, "SOURCE_CHANGED");
  assert.equal(result.sourceUnchanged, false);
});

test("source change during baseline blocks alternatives", async () => {
  for (const responder of [undefined, (_handle, method) => method === "eth_chainId" ? "0xa" : header()]) {
    let reads = 0;
    const { result } = await run({ responder, options: { readSource: () => ++reads < 3 ? SOURCE : Buffer.from("changed") } });
    assert.equal(result.status, "SOURCE_CHANGED");
    assert.equal(result.alternativeNetworkCalls, 0);
    assert.equal(result.baseline.status, "SOURCE_CHANGED");
  }
});

test("inventory is loaded once at max96 and current baseline preserves exact default fallback/hint ordering", async () => {
  const inventory = ["https://ordinary.alchemy.com/dummy-secret", A, AA, I,
    ...Array.from({ length: 100 }, (_, index) => `https://fixture-${index}.invalid/dummy-secret`)];
  const responder = (_handle, method) => method === "eth_chainId" ? "0x1" : header();
  const { result, calls, loads } = await run({ inventory, responder });
  assert.equal(loads, 1);
  const baselineCalls = [];
  const expected = await diagnostic.diagnoseQualification({ inventoryLoader: () => inventory.slice(0, 96), now: () => NOW,
    rpcCall: async (...args) => { baselineCalls.push(args); return responder(...args); } });
  assert.deepEqual(result.baseline, expected);
  assert.deepEqual(calls.slice(0, expected.networkCalls).map((call) => [call.handle, call.method, call.params, call.timeout]), baselineCalls);
  assert.equal(result.baseline.selectedCandidateRows, 44);
  assert.equal(result.baseline.originalSourceSha, undefined);
  assert.equal(result.originalSourceSha, SHA);
});

test("wrong-chain primary recovers using one retained alternative and stops on second family", async () => {
  const { result, calls } = await run();
  assert.equal(result.status, "SECOND_FAMILY_FOUND_IN_EXISTING_POOL");
  assert.equal(result.baseline.status, "TWO_FAMILIES_UNAVAILABLE");
  assert.equal(result.baseline.finalizedQualified, 1);
  assert.equal(result.baseline.counts.WRONG_CHAIN, 2);
  assert.deepEqual(result.alternativeAttempts, [{ primaryAttemptOrdinal: 2, outcome: "FINALIZED_QUALIFIED", stage: "FINALIZED", reads: 2 }]);
  assert.deepEqual(calls.slice(result.baseline.networkCalls).map((call) => call.handle), [AA, AA]);
  assert.equal(calls.some((call) => call.handle === IA), false);
});

test("invalid primary can recover without misattributing an old baseline", async () => {
  const { result } = await run({ responder: (handle, method) => method === "eth_chainId"
    ? [A, I].includes(handle) ? null : "0xa" : header() });
  assert.equal(result.baseline.counts.INVALID_CHAIN_RESPONSE, 2);
  assert.equal(result.status, "SECOND_FAMILY_FOUND_IN_EXISTING_POOL");
});

test("missing alternative is a categorical coverage limit, not an extra probe", async () => {
  const { result, calls } = await run({ inventory: [A] });
  assert.equal(result.status, "EXISTING_POOL_STILL_INSUFFICIENT");
  assert.deepEqual(result.alternativeAttempts, [{ primaryAttemptOrdinal: 2, outcome: "NO_RETAINED_ALTERNATIVE", stage: "SKIPPED", reads: 0 }]);
  assert.equal(calls.length, result.baseline.networkCalls);
});

test("alternative already contacted by baseline retry is skipped and never retested", async () => {
  const { result, calls } = await run({ inventory: [A, AA, I], responder: (handle, method) => {
    if (handle === A) throw Object.assign(new Error("injected-secret"), { code: "RPC_TIMEOUT" });
    return method === "eth_chainId" ? [AA, I].includes(handle) ? "0x1" : "0xa" : header();
  } });
  assert.equal(result.baseline.automaticRetries, 1);
  assert.equal(result.counts.ALREADY_PROBED_BY_BASELINE, 1);
  assert.equal(result.counts.NO_RETAINED_ALTERNATIVE, 1);
  assert.equal(result.alternativeNetworkCalls, 0);
  assert.equal(calls.filter((call) => call.handle === AA).length, 1);
});

test("baseline finalized-stage retry also marks retained handle contacted", async () => {
  const { result, calls } = await run({ inventory: [A, AA], responder: (handle, method) => {
    if (handle === A && method !== "eth_chainId") throw { cause: { code: "ECONNRESET" } };
    if (handle === AA) return null;
    return method === "eth_chainId" ? "0xa" : header();
  } });
  assert.equal(result.counts.ALREADY_PROBED_BY_BASELINE, 1);
  assert.deepEqual(calls.filter((call) => call.handle === AA).map((call) => call.method), ["eth_getBlockByNumber"]);
});

test("two current primary families qualify: no alternative calls or records", async () => {
  const { result, calls } = await run({ responder: (_handle, method) => method === "eth_chainId" ? "0xa" : header() });
  assert.equal(result.status, "BASELINE_ALREADY_HAS_TWO_FAMILIES");
  assert.equal(result.alternativeNetworkCalls, 0);
  assert.deepEqual(result.alternativeAttempts, []);
  assert.equal(calls.length, 4);
  assert.equal(calls.some((call) => [AA, I, IA].includes(call.handle)), false);
});

test("all retained alternatives fail: insufficient only within existing pool", async () => {
  const { result } = await run({ responder: (_handle, method) => method === "eth_chainId" ? "0x1" : header() });
  assert.equal(result.status, "EXISTING_POOL_STILL_INSUFFICIENT");
  assert.equal(result.qualifiedFamiliesAfter, 0);
  assert.equal(result.counts.WRONG_CHAIN, 2);
  assert.equal(result.counts.NO_RETAINED_ALTERNATIVE, 1);
  assert.equal(result.alternativeNetworkCalls, 2);
});

test("zero baseline qualifiers require two distinct retained families, then suppress later checks", async () => {
  const { result, calls } = await run({ inventory: [A, AA, I, IA, Q, QA], responder: (handle, method) => method === "eth_chainId"
    ? [AA, IA, QA].includes(handle) ? "0xa" : "0x1" : header() });
  assert.equal(result.baseline.finalizedQualified, 0);
  assert.equal(result.status, "SECOND_FAMILY_FOUND_IN_EXISTING_POOL");
  assert.equal(result.counts.FINALIZED_QUALIFIED, 2);
  assert.equal(result.alternativeAttempts.length, 3); // One missing alternative, then two successes.
  assert.equal(calls.some((call) => call.handle === QA), false);
});

test("one needed alternative suppresses all later checks including missing-alternative records", async () => {
  const { result, calls } = await run({ inventory: [A, AA, I, Q, QA] });
  assert.equal(result.alternativeAttempts.length, 1);
  assert.equal(result.counts.NO_RETAINED_ALTERNATIVE, 0);
  assert.equal(calls.some((call) => call.handle === QA), false);
});

test("alternative chain parser rejects null, empty, malformed and non-quantity responses", async () => {
  for (const chain of [null, undefined, "", " ", "0x", "0xgg", "0x01", "10", 10, 10n, false, [], {}]) {
    const { result, calls } = await run({ inventory: [A, AA], responder: (handle, method) =>
      handle === AA ? chain : method === "eth_chainId" ? handle === A ? "0x1" : "0xa" : header() });
    assert.equal(result.counts.INVALID_CHAIN_RESPONSE, 1);
    assert.equal(result.alternativeNetworkCalls, 1);
    assert.equal(calls.filter((call) => call.handle === AA).every((call) => call.method === "eth_chainId"), true);
  }
});

test("valid nonmatching hex quantity is wrong chain and never reaches finalized", async () => {
  for (const chain of ["0x0", "0x1", "0xb", "0xFF"]) {
    const { result } = await run({ inventory: [A, AA], responder: (handle, method) =>
      handle === AA ? chain : method === "eth_chainId" ? handle === A ? "0x1" : "0xa" : header() });
    assert.equal(result.counts.WRONG_CHAIN, 1);
    assert.equal(result.alternativeNetworkCalls, 1);
  }
});

for (const [name, raw, outcome] of [
  ["null", null, "INVALID_HEADER"], ["malformed number", header({ number: "injected-secret" }), "INVALID_HEADER"],
  ["missing root", header({ stateRoot: undefined }), "INVALID_HEADER"],
  ["predeployment", header({ number: quantity(149521227), timestamp: "0x1" }), "PREDEPLOYMENT_HEADER"],
  ["stale", header({ timestamp: quantity(NOW / 1000 - 86401) }), "STALE_HEADER"],
  ["future", header({ timestamp: quantity(NOW / 1000 + 301) }), "FUTURE_HEADER"]
]) test(`retained alternative ${name} header is ${outcome}`, async () => {
  const { result } = await run({ inventory: [A, AA], responder: (handle, method) =>
    method === "eth_chainId" ? handle === A ? "0x1" : "0xa" : handle === AA ? raw : header() });
  assert.equal(result.counts[outcome], 1);
  assert.equal(result.alternativeNetworkCalls, 2);
  assert.equal(result.status, "EXISTING_POOL_STILL_INSUFFICIENT");
});

test("alternative header exact deployment/freshness boundaries are accepted", async () => {
  for (const overrides of [{ number: quantity(149521228) }, { timestamp: quantity(NOW / 1000 - 86400) },
    { timestamp: quantity(NOW / 1000 + 300) }]) {
    const { result } = await run({ inventory: [A, AA], responder: (handle, method) =>
      method === "eth_chainId" ? handle === A ? "0x1" : "0xa" : header(overrides) });
    assert.equal(result.status, "SECOND_FAMILY_FOUND_IN_EXISTING_POOL");
  }
});

test("alternative errors are categorized without retries, raw error fields or endpoint material", async () => {
  for (const stage of ["CHAIN", "FINALIZED"]) for (const transport of [true, false]) {
    const { result, calls } = await run({ inventory: [A, AA], responder: (handle, method) => {
      if (handle === AA && (stage === "CHAIN" || method !== "eth_chainId")) {
        throw Object.assign(new Error("https://fixture.invalid/injected-secret Bearer injected-secret"), {
          code: transport ? "RPC_TIMEOUT" : "injected-secret", headers: { authorization: "injected-secret" }, body: "injected-secret"
        });
      }
      return method === "eth_chainId" ? handle === A ? "0x1" : "0xa" : header();
    } });
    assert.equal(result.counts[transport ? "TRANSPORT_FAILURE" : "RPC_FAILURE"], 1);
    assert.equal(result.baseline.automaticRetries, 0);
    assert.equal(result.alternativeAttempts[0].stage, stage);
    assert.equal(calls.filter((call) => call.handle === AA).length, stage === "CHAIN" ? 1 : 2);
  }
});

test("only selected rows are eligible: third same-family endpoint and beyond-cap inventory never probed", async () => {
  const inventory = [A, AA, A3, ...Array.from({ length: 94 }, (_, index) => `https://fixture-${index}.invalid/dummy-secret`), I, IA];
  const { result, calls } = await run({ inventory, responder: (_handle, method) => method === "eth_chainId" ? "0x1" : header() });
  const selected = producer.candidatePool({ inventoryLoader: () => inventory.slice(0, 96) });
  assert.equal(result.baseline.selectedCandidateRows, 44);
  assert.equal(calls.every((call) => selected.some((row) => row.handle === call.handle)), true);
  assert.equal(calls.some((call) => [A3, I, IA].includes(call.handle)), false);
  assert.equal(result.alternativeAttempts.filter((row) => row.reads > 0).length, 1);
  assert.ok(result.totalNetworkCalls <= 80);
});

test("unrecognized families cannot become alternatives or satisfy the two-family requirement", async () => {
  const { result } = await run({ inventory: ["https://optimism.blastapi.io/dummy-secret"] });
  assert.equal(result.baseline.recognizedFamilyCount, 1); // Default fallback only.
  assert.equal(result.baseline.qualificationAttempts, 0);
  assert.equal(result.totalNetworkCalls, 0);
  assert.equal(result.status, "EXISTING_POOL_STILL_INSUFFICIENT");
});

test("inventory errors stay sanitized and cause zero calls", async () => {
  const { result, loads } = await run({ options: { inventoryLoader: () => { throw new Error("https://fixture.invalid/injected-secret"); } } });
  assert.equal(loads, 0);
  assert.equal(result.status, "INVENTORY_FAILURE");
  assert.equal(result.totalNetworkCalls, 0);
});

// VM seams cover unreachable safety boundaries; no live options or caps are added.
function withDiagnostic(replacement) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "diagnose-etherfi-retained-alternatives.js"), "utf8"), {
    module, __dirname, process, Buffer,
    require: (name) => name === "./diagnose-etherfi-qualification" ? { ...diagnostic, ...replacement } : require(name)
  });
  return module.exports;
}

test("shared allowlist blocks state/log/write/height selectors before tracked raw calls", async () => {
  let rejected = 0;
  const api = withDiagnostic({ diagnoseQualification: async (options) => {
    for (const [method, params, timeout] of [
      ["eth_call", [], 6000], ["eth_getStorageAt", [], 6000], ["eth_getLogs", [], 6000], ["eth_getCode", [], 6000],
      ["eth_sendRawTransaction", [], 6000], ["eth_sendTransaction", [], 6000], ["personal_sign", [], 3500],
      ["eth_getBlockByNumber", ["latest", false], 6000], ["eth_getBlockByNumber", ["0x1", false], 6000],
      ["eth_getBlockByNumber", ["finalized", true], 6000], ["eth_chainId", [], 6000]
    ]) {
      await assert.rejects(options.rpcCall(A, method, params, timeout), { message: "METHOD_REJECTED" });
      rejected += 1;
    }
    return diagnostic.diagnoseQualification(options);
  } });
  const { result } = await run({ api });
  assert.equal(rejected, 11);
  assert.equal(result.status, "SECOND_FAMILY_FOUND_IN_EXISTING_POOL");
});

test("total invocation cap stops before chain or before header, never an 81st raw call", async () => {
  for (const baselineCalls of [79, 80]) {
    const api = withDiagnostic({ diagnoseQualification: async (options) => {
      const baseline = await diagnostic.diagnoseQualification({ ...options, rpcCall: async (_handle, method) =>
        method === "eth_chainId" ? "0x1" : header() });
      for (let index = 0; index < baselineCalls; index += 1) await options.rpcCall(A, "eth_chainId", [], 3500);
      if (baselineCalls === 80) await assert.rejects(options.rpcCall(A, "eth_chainId", [], 3500), { code: "NETWORK_CALL_CAP" });
      baseline.networkCalls = baselineCalls;
      return baseline;
    } });
    const { result, calls } = await run({ api, inventory: [A, AA] });
    assert.equal(result.status, "NETWORK_CALL_CAP");
    assert.equal(calls.length, 80);
    assert.equal(result.alternativeNetworkCalls, 80 - baselineCalls);
    assert.equal(result.counts.NETWORK_CALL_CAP, 1);
    assert.equal(result.alternativeAttempts.at(-1).stage, baselineCalls === 80 ? "CHAIN" : "FINALIZED");
  }
});

test("baseline cap or refusal stops without any alternate calls", async () => {
  for (const status of ["NETWORK_CALL_CAP", "UNEXPECTED", "OUTPUT_SCHEMA_INVALID"]) {
    const api = withDiagnostic({ diagnoseQualification: async (options) => {
      const baseline = await diagnostic.diagnoseQualification(options);
      baseline.status = status;
      return baseline;
    } });
    const { result } = await run({ api });
    assert.equal(result.status, status === "NETWORK_CALL_CAP" ? "NETWORK_CALL_CAP" : "BASELINE_REFUSED");
    assert.equal(result.alternativeNetworkCalls, 0);
  }
});

test("baseline schema/count mismatch refuses before alternatives", async () => {
  for (const mutate of [(value) => { value.raw = "injected-secret"; },
    (value) => { value.selectedCandidateRows += 1; }, (value) => { value.networkCalls += 1; }]) {
    const api = withDiagnostic({ diagnoseQualification: async (options) => {
      const baseline = await diagnostic.diagnoseQualification(options); mutate(baseline); return baseline;
    } });
    const { result } = await run({ api });
    assert.equal(result.status, "BASELINE_REFUSED");
    assert.equal(result.alternativeNetworkCalls, 0);
  }
});

test("result validator rejects extra fields, identities, arbitrary enums and inconsistent numeric/safety claims", async () => {
  const { result } = await run();
  for (const mutate of [
    (value) => { value.endpoint = "injected-secret"; }, (value) => { value.status = "READY"; },
    (value) => { value.originalSourceSha = "0".repeat(64); }, (value) => { value.safety.stateReads = 1; },
    (value) => { value.safety.sameSelectedPoolOnly = false; }, (value) => { value.limits.maxCandidates = 96; },
    (value) => { value.alternativeAttempts[0].handle = AA; }, (value) => { value.alternativeAttempts[0].outcome = "injected-secret"; },
    (value) => { value.alternativeAttempts[0].primaryAttemptOrdinal = 1; },
    (value) => { value.alternativeAttempts[0].reads = 3; }, (value) => { value.alternativeNetworkCalls += 1; },
    (value) => { value.totalNetworkCalls = 81; }, (value) => { value.counts.FINALIZED_QUALIFIED = 0; },
    (value) => { value.qualifiedFamiliesAfter = 1; }, (value) => { value.baseline.raw = "injected-secret"; },
    (value) => { value.sourceUnchanged = false; }
  ]) {
    const changed = structuredClone(result); mutate(changed);
    assert.equal(retained.validateResult(changed), false);
  }
});
