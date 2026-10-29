#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const harness = require("./run-critical-derive-v2-current-runtime-binding-r1.js");

const HASH = `0x${"ab".repeat(32)}`;
const NUMBER = "0x123";
const ZERO_WORD = `0x${"00".repeat(32)}`;
const DRIFT_IMPLEMENTATION = `0x${"11".repeat(20)}`;
const DRIFT_ADMIN = `0x${"22".repeat(20)}`;
function endpoint(ordinal) {
  const scheme = "http" + "s";
  const host = ["node", String(ordinal), "example", "invalid"].join(".");
  return scheme + ":" + "/" + "/" + host;
}
function candidate(name, ordinal) { return { endpoint: endpoint(ordinal), headers: {}, familyLabel: name }; }
function rpcResult(request, result) { return { jsonrpc: "2.0", id: request.id, result }; }
function wordAddress(address) { return `0x${address.slice(2).padStart(64, "0")}`; }
function wordUint(value) { return `0x${BigInt(value).toString(16).padStart(64, "0")}`; }
function words(values) { return `0x${values.map((value) => BigInt(value).toString(16).padStart(64, "0")).join("")}`; }

function fixtureTransport(options = {}) {
  const calls = [];
  const perFamilyBlockHashCalls = new Map();
  const transport = async (row, request) => {
    calls.push({ family: row.familyLabel, method: request.method, params: request.params });
    if (options.transportFailureFamily === row.familyLabel) throw new Error("injected");
    if (options.malformed && request.method === "eth_chainId") return { unexpected: true };
    if (request.method === "eth_chainId") {
      const value = options.chainMismatchFamily === row.familyLabel ? "0x1" : `0x${harness.CHAIN_ID.toString(16)}`;
      return rpcResult(request, value);
    }
    if (request.method === "eth_getBlockByNumber") {
      const hash = options.pinMismatchFamily === row.familyLabel ? `0x${"cd".repeat(32)}` : HASH;
      return rpcResult(request, { number: NUMBER, hash });
    }
    if (request.method === "eth_getBlockByHash") {
      const count = (perFamilyBlockHashCalls.get(row.familyLabel) || 0) + 1;
      perFamilyBlockHashCalls.set(row.familyLabel, count);
      const hash = options.terminalMismatchFamily === row.familyLabel ? `0x${"ef".repeat(32)}` : HASH;
      return rpcResult(request, { number: NUMBER, hash });
    }
    if (request.method === "eth_getStorageAt") {
      const slot = request.params[1];
      if (options.malformedSlot && slot === harness.EIP1967_SLOTS.implementation) return rpcResult(request, `0x${"ff".repeat(32)}`);
      let address = options.currentImplementation || harness.ADDRESSES.pmrm2ManifestImplementation;
      if (slot === harness.EIP1967_SLOTS.admin) address = options.currentAdmin || harness.ADDRESSES.pmrm2ManifestAdmin;
      if (slot === harness.EIP1967_SLOTS.beacon) address = options.currentBeacon || "0x" + "00".repeat(20);
      return rpcResult(request, wordAddress(address));
    }
    if (request.method === "eth_getCode") return rpcResult(request, options.missingCode ? "0x" : "0x60016000");
    if (request.method === "eth_call") {
      const call = request.params[0];
      const selector = call.data.slice(0, 10);
      let result;
      if (selector === harness.SELECTORS.subAccounts) result = wordAddress(harness.ADDRESSES.subAccounts);
      else if (selector === harness.SELECTORS.cashAsset) result = wordAddress(harness.ADDRESSES.cash);
      else if (selector === harness.SELECTORS.perp) result = wordAddress(harness.ADDRESSES.ethPerp);
      else if (selector === harness.SELECTORS.rateModel) result = wordAddress(options.topologyMismatch ? harness.ADDRESSES.cash : harness.ADDRESSES.rateModel);
      else if (selector === harness.SELECTORS.whitelistedManager) result = wordUint(1);
      else if (selector === harness.SELECTORS.adjustmentsPaused) result = wordUint(0);
      else if (selector === harness.SELECTORS.borrowingEnabled) result = wordUint(1);
      else if (selector === harness.SELECTORS.isDisabled) result = wordUint(0);
      else if (selector === harness.SELECTORS.totalSupply) result = wordUint(100);
      else if (selector === harness.SELECTORS.totalBorrow) result = wordUint(20);
      else if (selector === harness.SELECTORS.netSettledCash) result = wordUint(3);
      else if (selector === harness.SELECTORS.lastTimestamp) result = wordUint(10);
      else if (selector === harness.SELECTORS.lastMarketId) result = wordUint(4);
      else if (selector === harness.SELECTORS.assetDetails) result = words([1, 2, 1]);
      else if (selector === harness.SELECTORS.assetMap) result = wordAddress(harness.ADDRESSES.ethPerp);
      else throw new Error("unexpected selector");
      return rpcResult(request, result);
    }
    throw new Error("unexpected method");
  };
  return { transport, calls };
}

test("preflight performs zero inventory and network reads", async () => {
  let inventoryReads = 0, networkReads = 0;
  const result = await harness.main([], {
    readInventory: () => { inventoryReads++; return Buffer.alloc(0); },
    transport: async () => { networkReads++; },
  });
  assert.deepEqual(result, { mode: "PREFLIGHT", inventoryReads: 0, networkRequests: 0, captureRequired: true });
  assert.equal(inventoryReads, 0);
  assert.equal(networkReads, 0);
});

test("inventory parsing is capped, ranks Derive context, and derives families internally", () => {
  const lines = [];
  for (let index = 0; index < 13; index++) lines.push(`${index === 12 ? "Derive chain 957 " : ""}${endpoint(index)}`);
  const parsed = harness.parseInventorySafely(lines.join("\n"));
  assert.equal(parsed.length, harness.MAX_CANDIDATES);
  assert.equal(parsed[0].endpoint, `${endpoint(12)}/`);
  assert.equal(typeof parsed[0].familyLabel, "string");
  assert.ok(!Object.hasOwn(parsed[0], "priority"));
});

test("RPC allowlist, budget, timeout cap, and zero retries fail closed", async () => {
  let attempts = 0;
  const rpc = harness.createRpcClient({ maxRequests: 1, transport: async () => { attempts++; throw new Error("injected"); } });
  await assert.rejects(rpc.request(candidate("a", 1), "eth_chainId", []), /TRANSPORT_FAILURE/);
  assert.equal(attempts, 1);
  assert.equal(rpc.state.retries, 0);
  await assert.rejects(rpc.request(candidate("a", 1), "eth_chainId", []), /RPC_BUDGET_EXCEEDED/);
  await assert.rejects(harness.createRpcClient().request(candidate("a", 1), "eth_getLogs", []), /RPC_METHOD_FORBIDDEN/);
  assert.throws(() => harness.createRpcClient({ timeoutMs: harness.MAX_TIMEOUT_MS + 1 }), /TIMEOUT_CAP_INVALID/);
});

test("two independent families qualify on one finalized pin", async () => {
  const fixture = fixtureTransport();
  const rpc = harness.createRpcClient({ transport: fixture.transport });
  const result = await harness.qualifyAndSelect([candidate("alpha", 1), candidate("beta", 2)], rpc);
  assert.equal(result.selected.length, 2);
  assert.deepEqual(harness.assertFixedPinAgreement(result.selected), { number: BigInt(NUMBER), hash: HASH });
});

for (const scenario of [
  ["chain mismatch", { chainMismatchFamily: "beta" }],
  ["finalized pin mismatch", { pinMismatchFamily: "beta" }],
  ["transport failure", { transportFailureFamily: "beta" }],
]) {
  test(`qualification rejects ${scenario[0]}`, async () => {
    const fixture = fixtureTransport(scenario[1]);
    const rpc = harness.createRpcClient({ transport: fixture.transport });
    await assert.rejects(harness.qualifyAndSelect([candidate("alpha", 1), candidate("beta", 2)], rpc), /INCOMPLETE_INDEPENDENT_FAMILIES/);
  });
}

test("qualification rejects two endpoints from one family", async () => {
  const fixture = fixtureTransport();
  const rpc = harness.createRpcClient({ transport: fixture.transport });
  await assert.rejects(harness.qualifyAndSelect([candidate("same", 1), candidate("same", 2)], rpc), /INCOMPLETE_INDEPENDENT_FAMILIES/);
});

test("proxy slot resolution accepts current drift but rejects malformed, zero, or beacon-conflicting slots", () => {
  const valid = {
    implementation: wordAddress(harness.ADDRESSES.pmrm2ManifestImplementation),
    admin: wordAddress(harness.ADDRESSES.pmrm2ManifestAdmin),
    beacon: ZERO_WORD,
  };
  assert.equal(harness.resolveProxySlots(valid).implementation, harness.ADDRESSES.pmrm2ManifestImplementation);
  assert.deepEqual(harness.resolveProxySlots({ ...valid, implementation: wordAddress(DRIFT_IMPLEMENTATION), admin: wordAddress(DRIFT_ADMIN) }), {
    implementation: DRIFT_IMPLEMENTATION,
    admin: DRIFT_ADMIN,
    beacon: "0x" + "00".repeat(20),
  });
  assert.throws(() => harness.resolveProxySlots({ ...valid, implementation: ZERO_WORD }), /PROXY_IMPLEMENTATION_SLOT_ZERO/);
  assert.throws(() => harness.resolveProxySlots({ ...valid, admin: ZERO_WORD }), /PROXY_ADMIN_SLOT_ZERO/);
  assert.throws(() => harness.resolveProxySlots({ ...valid, implementation: `0x${"ff".repeat(32)}` }), /PROXY_SLOT_MALFORMED/);
  assert.throws(() => harness.resolveProxySlots({ ...valid, beacon: wordAddress(harness.ADDRESSES.cash) }), /PROXY_BEACON_SLOT_CONFLICT/);
});

test("capture binds code, implementation, topology, fixed pin, and only read methods", async () => {
  const fixture = fixtureTransport();
  const output = await harness.captureRunner({ candidates: [candidate("alpha", 1), candidate("beta", 2)], transport: fixture.transport });
  assert.equal(output.classification, "BOUND_TOPOLOGY_PARTIAL");
  assert.equal(output.proxy.implementation, harness.ADDRESSES.pmrm2ManifestImplementation);
  assert.equal(output.topology.cash.pmrm2Whitelisted, true);
  assert.equal(output.topology.perp.pmrm2Whitelisted, true);
  assert.equal(output.topology.srm.ethPerpRegistration.assetMap, harness.ADDRESSES.ethPerp);
  assert.equal(output.finalizedPin.hash, HASH);
  assert.ok(output.rpcPolicy.requestsUsed <= harness.MAX_RPC_REQUESTS);
  assert.equal(fixture.calls.every((call) => harness.ALLOWED_RPC_METHODS.includes(call.method)), true);
  assert.equal(fixture.calls.some((entry) => entry.method === "eth_call" && entry.params[0].data.startsWith(harness.SOURCE.settlementSelector)), false);
  assert.equal(harness.validateOutput(output), true);
});

test("topology pass, mismatch, and unknown outcomes remain non-finding classifications", async () => {
  const mismatchFixture = fixtureTransport({ topologyMismatch: true });
  const mismatch = await harness.captureRunner({ candidates: [candidate("alpha", 1), candidate("beta", 2)], transport: mismatchFixture.transport });
  assert.equal(mismatch.classification, "RUNTIME_MISMATCH");
  const unknownFacts = {
    pmrm2: { subAccounts: harness.ADDRESSES.subAccounts, cashAsset: harness.ADDRESSES.cash, perp: harness.ADDRESSES.ethPerp },
    cash: { subAccounts: harness.ADDRESSES.subAccounts, rateModel: harness.ADDRESSES.rateModel, pmrm2Whitelisted: true },
    perp: { subAccounts: harness.ADDRESSES.subAccounts },
    srm: {},
  };
  assert.equal(harness.evaluateTopology(unknownFacts), "INCOMPLETE_TOPOLOGY");
  assert.doesNotMatch(mismatch.classification, /finding|vulnerab|execut|route/i);
});

test("current implementation/admin slot drift is captured as a serialized non-finding mismatch", async () => {
  const fixture = fixtureTransport({ currentImplementation: DRIFT_IMPLEMENTATION, currentAdmin: DRIFT_ADMIN });
  const output = await harness.captureRunner({ candidates: [candidate("alpha", 1), candidate("beta", 2)], transport: fixture.transport });
  assert.equal(output.classification, "RUNTIME_MISMATCH");
  assert.equal(output.proxy.implementation, DRIFT_IMPLEMENTATION);
  assert.equal(output.proxy.admin, DRIFT_ADMIN);
  assert.equal(output.proxy.manifestImplementationMatch, false);
  assert.equal(output.proxy.manifestAdminMatch, false);
  assert.equal(output.code.pmrm2Implementation.address, DRIFT_IMPLEMENTATION);
  assert.equal(fixture.calls.some((entry) => entry.method === "eth_getCode" && entry.params[0] === DRIFT_IMPLEMENTATION), true);
  assert.equal(fixture.calls.some((entry) => entry.method === "eth_call" && entry.params[0].to === harness.ADDRESSES.pmrm2Proxy
    && entry.params[0].data.startsWith(harness.SELECTORS.cashAsset)), true);
  assert.doesNotMatch(harness.serializeOutput(output), /0x60016000|jsonrpc/);
});

test("terminal hash recheck, missing code, malformed reply, and conflicting slot reject", async () => {
  for (const [options, expression] of [
    [{ terminalMismatchFamily: "beta" }, /TERMINAL_PIN_RECHECK_FAILED/],
    [{ missingCode: true }, /MISSING_OR_OVERSIZED_CODE/],
    [{ malformed: true }, /INCOMPLETE_INDEPENDENT_FAMILIES/],
    [{ currentImplementation: "0x" + "00".repeat(20) }, /PROXY_IMPLEMENTATION_SLOT_ZERO/],
    [{ currentAdmin: "0x" + "00".repeat(20) }, /PROXY_ADMIN_SLOT_ZERO/],
    [{ malformedSlot: true }, /PROXY_SLOT_MALFORMED/],
    [{ currentBeacon: harness.ADDRESSES.cash }, /PROXY_BEACON_SLOT_CONFLICT/],
  ]) {
    const fixture = fixtureTransport(options);
    await assert.rejects(harness.captureRunner({ candidates: [candidate("alpha", 1), candidate("beta", 2)], transport: fixture.transport }), expression);
  }
});

test("serialization emits commitments only and rejects provider or raw material", async () => {
  const fixture = fixtureTransport();
  const output = await harness.captureRunner({ candidates: [candidate("alpha", 1), candidate("beta", 2)], transport: fixture.transport });
  const serialized = harness.serializeOutput(output);
  assert.equal(serialized.includes(endpoint(1)), false);
  assert.equal(serialized.includes("0x60016000"), false);
  assert.equal(serialized.includes("jsonrpc"), false);
  assert.equal(output.sourceAuthority.runtimeSourceEquivalence, "UNKNOWN_NOT_BUILT");
  assert.equal(output.gates.routePositive, "unknown");
  const leaked = structuredClone(output);
  leaked.note = endpoint(7);
  assert.throws(() => harness.serializeOutput(leaked), /OUTPUT_NETWORK_MATERIAL/);
  const raw = structuredClone(output);
  raw.code.cash.bytecode = "0x6001";
  assert.throws(() => harness.serializeOutput(raw), /OUTPUT_FORBIDDEN_KEY/);
});

test("artifact overwrite is rejected without writing", async () => {
  const fixture = fixtureTransport();
  const output = await harness.captureRunner({ candidates: [candidate("alpha", 1), candidate("beta", 2)], transport: fixture.transport });
  let writes = 0;
  const fakeFs = {
    openSync() { const error = new Error("exists"); error.code = "EEXIST"; throw error; },
    writeFileSync() { writes++; },
    closeSync() {},
  };
  assert.throws(() => harness.writeArtifactExclusive("capture.json", output, fakeFs), /ARTIFACT_OVERWRITE_REJECTED/);
  assert.equal(writes, 0);
});

test("committed harness and test contain no provider-shaped source literal", () => {
  const source = require("node:fs").readFileSync(__filename, "utf8")
    + require("node:fs").readFileSync(require.resolve("./run-critical-derive-v2-current-runtime-binding-r1.js"), "utf8");
  const marker = "http" + "s" + ":" + "/" + "/";
  assert.equal(source.includes(marker), false);
});
