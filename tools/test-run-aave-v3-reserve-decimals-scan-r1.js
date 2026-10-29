"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const scanner = require("./run-aave-v3-reserve-decimals-scan-r1");

const { providerInterface, poolInterface, dataProviderInterface, erc20Interface } = scanner.interfaces;
const ADDRESSES = Object.freeze({
  provider: "0x0000000000000000000000000000000000000010",
  pool: "0x0000000000000000000000000000000000000020",
  configurator: "0x0000000000000000000000000000000000000030",
  oracle: "0x0000000000000000000000000000000000000040",
  dataProvider: "0x0000000000000000000000000000000000000050",
  reserve: "0x0000000000000000000000000000000000000060"
});
const HASH = `0x${"11".repeat(32)}`, ROOT_HASH = `0x${"22".repeat(32)}`;
const HEADER = Object.freeze({ number: "0x64", timestamp: "0x3e8", hash: HASH, stateRoot: ROOT_HASH });
const SOURCE = Object.freeze({
  origin: Object.freeze({ commit: scanner.SOURCE_PINS.originCommit, tree: scanner.SOURCE_PINS.originTree, configuratorLogicSha256: scanner.EXPECTED_SOURCE_SHA256.configuratorLogic }),
  addressBook: Object.freeze({ commit: scanner.SOURCE_PINS.addressBookCommit, tree: scanner.SOURCE_PINS.addressBookTree, aaveV3EthereumSha256: scanner.EXPECTED_SOURCE_SHA256.addressBook })
});
const URLS = Object.freeze({
  alchemy: "https://z-fixture.alchemy.com/v2/offline-a",
  infura: "https://a-fixture.infura.io/v3/offline-b",
  alchemySecond: "https://second.alchemy.com/v2/offline-c",
  publicnode: "https://ethereum-rpc.publicnode.com/offline"
});
function candidate(url, inventoryOrder = 0, operatorFamily) {
  return Object.freeze({ handle: Object.freeze({ url: new URL(url), headers: Object.freeze({}) }), inventoryOrder, ...(operatorFamily ? { operatorFamily } : {}) });
}
const CANDIDATES = Object.freeze([candidate(URLS.alchemy, 4), candidate(URLS.infura, 7)]);
const wire = (result, wireBytes = 128) => Object.freeze({ result, wireBytes });
function wireError(code, wireBytes = 0) { const error = new scanner.ScanError(code); error.wireBytes = wireBytes; return error; }
const configurationResult = (decimals) => dataProviderInterface.encodeFunctionResult("getReserveConfigurationData", [decimals, 0, 0, 0, 0, false, false, false, true, false]);
const selector = (data) => data.slice(0, 10).toLowerCase();
const addressAt = (index) => `0x${BigInt(index).toString(16).padStart(40, "0")}`;
function invalidAddressArrayResult() {
  return `0x${(32n).toString(16).padStart(64, "0")}${(1n).toString(16).padStart(64, "0")}${"ff".repeat(12)}${ADDRESSES.reserve.slice(2)}`;
}

function makeTransport(options = {}) {
  const exactHeaderCalls = new Map(), calls = options.calls || [];
  return async (handle, method, params) => {
    const host = handle.url.hostname, family = host.includes("infura") ? "infura" : host.includes("publicnode") ? "publicnode" : "alchemy";
    calls.push({ host, method, headers: { ...handle.headers } });
    if (options.oneFamilyFailure && family === "infura") throw wireError("OFFLINE_FAILURE");
    const finish = (result) => wire(result, options.wireBytes ?? 128);
    if (method === "eth_chainId") return finish("0x1");
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "finalized") return finish(HEADER);
      const count = (exactHeaderCalls.get(host) || 0) + 1;
      exactHeaderCalls.set(host, count);
      if (options.terminalFailure && family === "infura" && count >= 2) return finish({ ...HEADER, hash: `0x${"33".repeat(32)}` });
      return finish(HEADER);
    }
    assert.equal(method, "eth_call");
    const transaction = params[0], target = transaction.to.toLowerCase(), sig = selector(transaction.data);
    if (target === ADDRESSES.provider) {
      const bindings = [
        [providerInterface.getFunction("getPool").selector, "getPool", ADDRESSES.pool],
        [providerInterface.getFunction("getPoolConfigurator").selector, "getPoolConfigurator", ADDRESSES.configurator],
        [providerInterface.getFunction("getPriceOracle").selector, "getPriceOracle", ADDRESSES.oracle],
        [providerInterface.getFunction("getPoolDataProvider").selector, "getPoolDataProvider", ADDRESSES.dataProvider]
      ];
      const row = bindings.find(([value]) => value.toLowerCase() === sig);
      if (!row) throw new Error("unexpected provider selector");
      return finish(providerInterface.encodeFunctionResult(row[1], [row[2]]));
    }
    if (target === ADDRESSES.pool && sig === poolInterface.getFunction("getReservesList").selector.toLowerCase()) {
      if (options.familyStateFailure && family === "infura") throw wireError("STATE_FAILURE", 32);
      if (options.malformedList) return finish("0x01");
      if (options.invalidAddressList) return finish(invalidAddressArrayResult());
      const list = options.reserveList || [ADDRESSES.reserve];
      return finish(poolInterface.encodeFunctionResult("getReservesList", [list]));
    }
    if (target === ADDRESSES.dataProvider) {
      if (options.storedFailure) throw wireError("STORED_FAILURE", 32);
      const value = options.crossFamilyDisagreement && family === "infura" ? 78 : options.storedDecimals ?? 77;
      return finish(configurationResult(value));
    }
    if (target === ADDRESSES.pool && sig === poolInterface.getFunction("getConfiguration").selector.toLowerCase()) {
      const decimals = options.packedDecimals ?? options.storedDecimals ?? 77;
      return finish(poolInterface.encodeFunctionResult("getConfiguration", [BigInt(decimals) << 48n]));
    }
    if (target === ADDRESSES.reserve || /^0x0{35}[0-9a-f]{5}$/u.test(target)) {
      if (options.liveMalformed) return finish("0x01");
      return finish(erc20Interface.encodeFunctionResult("decimals", [options.liveDecimals ?? options.storedDecimals ?? 77]));
    }
    throw new Error("unexpected call target");
  };
}
async function run(options = {}) {
  return scanner.runScanner({
    candidates: options.candidates || CANDIDATES,
    bootstrapLocator: ADDRESSES.provider,
    sourceCommitments: SOURCE,
    transport: options.transport || makeTransport(options),
    generatedAt: options.generatedAt || "2026-08-30T00:00:00.000Z",
    now: options.now || (() => 1)
  });
}
function withoutGeneratedAt(value) { const copy = structuredClone(value); delete copy.generatedAt; return copy; }
function publicText(value) { return JSON.stringify(value); }

test("77 decimals passes with two genuinely independent URL-derived families", async () => {
  const result = await run({ storedDecimals: 77 });
  assert.equal(result.status, "PASS_NO_DECIMALS_RISK");
  assert.deepEqual(result.counts, { reserves: 1, pass: 1, risk: 0, incomplete: 0, storedLiveMismatch: 0, storedPackedMismatch: 0, outsideRange: 0 });
  assert.equal(result.qualification.twoIndependentFamilies, true);
  assert.equal(result.agreement.terminalHeaderRecheck, true);
});

test("78 and stored/live mismatch produce aggregate-only risk signals", async () => {
  const upper = await run({ storedDecimals: 78 });
  assert.equal(upper.status, "RISK_SIGNAL");
  assert.equal(upper.signals.outsideRange, 1);
  const mismatch = await run({ storedDecimals: 18, liveDecimals: 6, packedDecimals: 18 });
  assert.equal(mismatch.status, "RISK_SIGNAL");
  assert.equal(mismatch.signals.storedLiveMismatch, 1);
  for (const result of [upper, mismatch]) {
    assert.equal(/ordinal|nonPassRows|storedDecimals|liveDecimals|packedDecimals|0x0{10,}/u.test(publicText(result)), false);
  }
});

test("malformed or failing decimals is INCOMPLETE", async () => {
  for (const fixture of [{ liveMalformed: true }, { storedFailure: true }]) {
    const result = await run(fixture);
    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.counts.incomplete, 1);
  }
});

test("empty, duplicate, invalid-address, malformed, and over-cap reserve lists are INCOMPLETE", async () => {
  const cases = [
    { reserveList: [] },
    { reserveList: [ADDRESSES.reserve, ADDRESSES.reserve] },
    { invalidAddressList: true },
    { malformedList: true },
    { reserveList: Array.from({ length: scanner.LIMITS.reserves + 1 }, (_, index) => addressAt(index + 0x100)) }
  ];
  for (const fixture of cases) {
    const result = await run(fixture);
    assert.equal(result.status, "INCOMPLETE");
    assert.deepEqual(result.diagnostics, ["ONE_OR_MORE_FAMILY_STATE_READS_INCOMPLETE"]);
  }
});

test("cross-family state disagreement, one-family failure, and terminal failure fail closed", async () => {
  const disagreement = await run({ crossFamilyDisagreement: true });
  assert.equal(disagreement.status, "INCOMPLETE");
  assert.deepEqual(disagreement.diagnostics, ["CROSS_FAMILY_STATE_DISAGREEMENT"]);
  const failure = await run({ familyStateFailure: true });
  assert.equal(failure.status, "INCOMPLETE");
  assert.deepEqual(failure.diagnostics, ["ONE_OR_MORE_FAMILY_STATE_READS_INCOMPLETE"]);
  const qualificationFailure = await run({ oneFamilyFailure: true });
  assert.equal(qualificationFailure.status, "INCOMPLETE");
  assert.deepEqual(qualificationFailure.diagnostics, ["TWO_FAMILIES_UNAVAILABLE"]);
  const terminal = await run({ terminalFailure: true });
  assert.equal(terminal.status, "INCOMPLETE");
  assert.deepEqual(terminal.diagnostics, ["TERMINAL_HEADER_RECHECK_FAILED"]);
});

test("mislabeled endpoint is rejected and same-family pair is unavailable", async () => {
  const mislabeled = await run({ candidates: [candidate(URLS.alchemy, 0, "infura"), candidate(URLS.infura, 1)] });
  assert.equal(mislabeled.status, "INCOMPLETE");
  assert.deepEqual(mislabeled.diagnostics, ["TWO_FAMILIES_UNAVAILABLE"]);
  const sameFamily = await run({ candidates: [candidate(URLS.alchemy, 0), candidate(URLS.alchemySecond, 1)] });
  assert.equal(sameFamily.status, "INCOMPLETE");
  assert.deepEqual(sameFamily.diagnostics, ["TWO_FAMILIES_UNAVAILABLE"]);
});

test("capability rank then inventory order controls selection, never hostname alphabetics", async () => {
  const calls = [];
  await run({
    candidates: [candidate(URLS.publicnode, 0), candidate(URLS.infura, 9), candidate(URLS.alchemy, 2)],
    transport: makeTransport({ calls })
  });
  const chainHosts = calls.filter((row) => row.method === "eth_chainId").map((row) => row.host);
  assert.deepEqual(chainHosts, ["z-fixture.alchemy.com", "a-fixture.infura.io", "ethereum-rpc.publicnode.com"]);
});

test("inventory annotations are record-owned and never cross hosts", async () => {
  const inventory = Buffer.from(`${URLS.alchemy} [header:x-api-token=alpha-secret]\n\n${URLS.infura}\n`);
  const parsed = scanner.parseInventory(inventory);
  assert.equal(parsed.candidates.length, 2);
  const calls = [];
  await scanner.runScanner({ candidates: parsed.candidates, bootstrapLocator: ADDRESSES.provider, sourceCommitments: SOURCE, secretCorpus: parsed.secretCorpus, transport: makeTransport({ calls }), generatedAt: "2026-08-30T00:00:00.000Z", now: () => 1 });
  const alchemyCalls = calls.filter((row) => row.host.includes("alchemy")), infuraCalls = calls.filter((row) => row.host.includes("infura"));
  assert.ok(alchemyCalls.every((row) => row.headers["x-api-token"] === "alpha-secret"));
  assert.ok(infuraCalls.every((row) => !Object.hasOwn(row.headers, "x-api-token")));
});

test("adjacent ambiguous URL/header blocks and orphan annotations are skipped without transmission", async () => {
  const ambiguous = Buffer.from(`${URLS.alchemy} [header:x-api-token=must-not-move]\n${URLS.infura}\n\n[header:x-orphan=orphan]\n\n${URLS.publicnode}\n`);
  const parsed = scanner.parseInventory(ambiguous);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].handle.url.hostname, "ethereum-rpc.publicnode.com");
  assert.deepEqual(parsed.candidates[0].handle.headers, {});
  const calls = [];
  const result = await scanner.runScanner({ candidates: parsed.candidates, bootstrapLocator: ADDRESSES.provider, sourceCommitments: SOURCE, secretCorpus: parsed.secretCorpus, transport: makeTransport({ calls }), generatedAt: "2026-08-30T00:00:00.000Z", now: () => 1 });
  assert.equal(result.status, "INCOMPLETE");
  assert.ok(calls.every((row) => !Object.hasOwn(row.headers, "x-api-token") && !Object.hasOwn(row.headers, "x-orphan")));
});

test("normalized endpoint identity deduplicates duplicate URLs", async () => {
  const duplicate = await run({ candidates: [candidate(`${URLS.alchemy}/`, 0), candidate(`${URLS.alchemy}/`, 1), candidate(URLS.infura, 2)] });
  assert.equal(duplicate.status, "PASS_NO_DECIMALS_RISK");
  assert.equal(duplicate.qualification.qualifiedFamilies, 2);
});

test("bootstrap parser strips comments and requires exactly one exact declaration", () => {
  const declaration = `IPoolAddressesProvider internal constant POOL_ADDRESSES_PROVIDER = IPoolAddressesProvider(${ADDRESSES.provider});`;
  assert.equal(scanner.parseBootstrapLocator(`// fake IPoolAddressesProvider(0x${"f".repeat(40)})\n${declaration}`), ADDRESSES.provider);
  assert.throws(() => scanner.parseBootstrapLocator(`// ${declaration}`), (error) => error.code === "BOOTSTRAP_LOCATOR_NOT_FOUND");
  assert.throws(() => scanner.parseBootstrapLocator(`${declaration}\n${declaration}`), (error) => error.code === "BOOTSTRAP_LOCATOR_DUPLICATE");
  assert.throws(() => scanner.parseBootstrapLocator(`${declaration}\naddress POOL_ADDRESSES_PROVIDER = malformed;`), (error) => error.code === "BOOTSTRAP_LOCATOR_DUPLICATE");
  assert.throws(() => scanner.parseBootstrapLocator("POOL_ADDRESSES_PROVIDER = malformed;"), (error) => error.code === "BOOTSTRAP_LOCATOR_NOT_FOUND");
});

function sourceFixtureFs({ mutateAddressBook = false, mutateOrigin = false, inventorySize = null } = {}) {
  const addressBook = fs.readFileSync(path.join(__dirname, "..", "targets", "aave-address-book-6a0ac5a", "src", "AaveV3Ethereum.sol"));
  const origin = fs.readFileSync(path.join(__dirname, "..", "targets", "aave-v3-origin-v3.7-cff15de", "src", "contracts", "protocol", "libraries", "logic", "ConfiguratorLogic.sol"));
  const inventory = Buffer.from(`${URLS.alchemy}\n\n${URLS.infura}\n`), events = [];
  const bytesFor = (file) => file.endsWith("AaveV3Ethereum.sol") ? (mutateAddressBook ? Buffer.concat([addressBook, Buffer.from(" ")]) : addressBook)
    : file.endsWith("ConfiguratorLogic.sol") ? (mutateOrigin ? Buffer.concat([origin, Buffer.from(" ")]) : origin) : inventory;
  const descriptors = new Map(); let nextDescriptor = 10;
  const statFor = (file) => { const bytes = bytesFor(file); return { isFile: () => true, size: file.endsWith("rpc_endpoints.txt") && inventorySize !== null ? inventorySize : bytes.length, dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4 }; };
  return {
    events,
    openSync(file) { events.push(`open:${path.basename(file)}`); const descriptor = nextDescriptor++; descriptors.set(descriptor, file); return descriptor; },
    fstatSync(descriptor) { const file = descriptors.get(descriptor); events.push(`fstat:${path.basename(file)}`); return statFor(file); },
    readSync(descriptor, buffer, offset, length) { const file = descriptors.get(descriptor), bytes = bytesFor(file); events.push(`read:${path.basename(file)}:${length}`); return bytes.copy(buffer, offset, 0, Math.min(bytes.length, length)); },
    closeSync(descriptor) { const file = descriptors.get(descriptor); events.push(`close:${path.basename(file)}`); descriptors.delete(descriptor); }
  };
}

test("source authority is verified before protected inventory read", () => {
  const spy = sourceFixtureFs();
  const loaded = scanner.loadAuthorizedInputs(spy);
  assert.equal(loaded.inventory.candidates.length, 2);
  const inventoryOpen = spy.events.indexOf("open:rpc_endpoints.txt");
  assert.ok(inventoryOpen > spy.events.indexOf("close:ConfiguratorLogic.sol"));
  const mutated = sourceFixtureFs({ mutateAddressBook: true });
  assert.throws(() => scanner.loadAuthorizedInputs(mutated), (error) => error.code === "ADDRESS_BOOK_AUTHORITY_MISMATCH");
  assert.equal(mutated.events.some((event) => event.includes("rpc_endpoints.txt")), false);
  const mutatedOrigin = sourceFixtureFs({ mutateOrigin: true });
  assert.throws(() => scanner.loadAuthorizedInputs(mutatedOrigin), (error) => error.code === "ORIGIN_SOURCE_AUTHORITY_MISMATCH");
  assert.equal(mutatedOrigin.events.some((event) => event.includes("rpc_endpoints.txt")), false);
});

test("injected engine rejects unauthorized source commitments before RPC", async () => {
  let calls = 0;
  const mutated = structuredClone(SOURCE);
  mutated.origin.configuratorLogicSha256 = "0".repeat(64);
  await assert.rejects(() => scanner.runScanner({
    candidates: CANDIDATES,
    bootstrapLocator: ADDRESSES.provider,
    sourceCommitments: mutated,
    transport: async () => { calls += 1; return wire("0x1"); },
    generatedAt: "2026-08-30T00:00:00.000Z"
  }), (error) => error.code === "SOURCE_COMMITMENTS_UNAUTHORIZED");
  assert.equal(calls, 0);
});

test("inventory stat cap prevents allocation/read", () => {
  const spy = sourceFixtureFs({ inventorySize: scanner.LIMITS.inventoryBytes + 1 });
  assert.throws(() => scanner.loadAuthorizedInputs(spy), (error) => error.code === "INVENTORY_SIZE_CAP");
  assert.equal(spy.events.some((event) => event.startsWith("read:rpc_endpoints.txt")), false);
  assert.throws(() => scanner.parseInventory(Buffer.alloc(scanner.LIMITS.inventoryBytes + 1)), (error) => error.code === "INVENTORY_SIZE_CAP");
});

test("one-descriptor bounded read detects growth without requesting or reading beyond maximum plus one", () => {
  const maximum = 8, huge = Buffer.alloc(1024 * 1024, 0x61); let fstats = 0, requested = 0, read = 0, closed = false;
  const raceFs = {
    openSync() { return 9; },
    fstatSync() { fstats += 1; return { isFile: () => true, size: fstats === 1 ? 4 : huge.length, dev: 1, ino: 2, mtimeMs: fstats, ctimeMs: fstats }; },
    readSync(_descriptor, buffer, offset, length) { requested += length; const copied = huge.copy(buffer, offset, 0, Math.min(length, huge.length)); read += copied; return copied; },
    closeSync() { closed = true; }
  };
  assert.throws(() => scanner.readBoundedFile("race", maximum, "RACE", raceFs), (error) => error.code === "RACE_READ_CHANGED_OR_TRUNCATED");
  assert.ok(requested <= maximum + 1);
  assert.ok(read <= maximum + 1);
  assert.equal(closed, true);
});

test("per-response wire cap latches fatally and permits zero additional calls", async () => {
  let calls = 0;
  const result = await run({ transport: async () => { calls += 1; return wire("0x1", scanner.LIMITS.responseBytes + 1); } });
  assert.equal(result.status, "INCOMPLETE");
  assert.deepEqual(result.diagnostics, ["RPC_RESPONSE_CAP"]);
  assert.equal(result.budget.withinBounds, false);
  assert.equal(calls, 1);
});

test("cumulative wire cap latches and prevents post-cap calls", async () => {
  let calls = 0;
  const base = makeTransport({ wireBytes: scanner.LIMITS.responseBytes });
  const result = await run({ transport: async (...args) => { calls += 1; return base(...args); } });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.budget.fatalBudgetCode, "RPC_TOTAL_RESPONSE_CAP");
  assert.equal(result.budget.withinBounds, false);
  assert.equal(calls, 17);
});

test("repeated malformed, non-200, and partial-response wire bytes cumulatively latch with zero post-cap calls", async () => {
  const failureSelectors = new Set([
    dataProviderInterface.getFunction("getReserveConfigurationData").selector.toLowerCase(),
    erc20Interface.getFunction("decimals").selector.toLowerCase(),
    poolInterface.getFunction("getConfiguration").selector.toLowerCase()
  ]);
  for (const code of ["TRANSPORT_JSON_INVALID", "TRANSPORT_HTTP_STATUS", "TRANSPORT_PARTIAL_RESPONSE"]) {
    const state = { received: 0, crossed: false, postCapCalls: 0 }, chunkBytes = scanner.LIMITS.responseBytes - 1024;
    const base = makeTransport({ reserveList: Array.from({ length: 10 }, (_, index) => addressAt(index + 0x100)) });
    const transport = async (...args) => {
      if (state.crossed) state.postCapCalls += 1;
      const [, method, params] = args;
      if (method === "eth_call" && failureSelectors.has(selector(params[0].data))) {
        state.received += chunkBytes;
        if (state.received > scanner.LIMITS.totalResponseBytes) state.crossed = true;
        throw wireError(code, chunkBytes);
      }
      const outcome = await base(...args);
      state.received += outcome.wireBytes;
      if (state.received > scanner.LIMITS.totalResponseBytes) state.crossed = true;
      return outcome;
    };
    const result = await run({ transport });
    assert.equal(result.status, "INCOMPLETE", code);
    assert.equal(result.budget.fatalBudgetCode, "RPC_TOTAL_RESPONSE_CAP", code);
    assert.equal(result.budget.withinBounds, false, code);
    assert.equal(state.postCapCalls, 0, code);
  }
});

test("wall-time cap latches before transport and permits zero calls", async () => {
  let calls = 0, ticks = 0;
  const result = await run({ now: () => ticks++ === 0 ? 0 : scanner.LIMITS.wallMs + 1, transport: async () => { calls += 1; return wire("0x1"); } });
  assert.equal(result.status, "INCOMPLETE");
  assert.deepEqual(result.diagnostics, ["WALL_CLOCK_CAP"]);
  assert.equal(result.budget.withinBounds, false);
  assert.equal(calls, 0);
});

test("JSON-RPC envelope requires exact version, ID, result ownership, and bounded valid JSON", () => {
  const encode = (value) => Buffer.from(JSON.stringify(value));
  const validBytes = encode({ jsonrpc: "2.0", id: 7, result: "0x1" });
  const valid = scanner.decodeJsonRpcEnvelope(validBytes, 7);
  assert.equal(valid.result, "0x1");
  assert.equal(valid.wireBytes, validBytes.length);
  const invalid = [
    [{ id: 7, result: "0x1" }, "TRANSPORT_JSONRPC_VERSION_INVALID"],
    [{ jsonrpc: "1.0", id: 7, result: "0x1" }, "TRANSPORT_JSONRPC_VERSION_INVALID"],
    [{ jsonrpc: "2.0", result: "0x1" }, "TRANSPORT_ID_MISMATCH"],
    [{ jsonrpc: "2.0", id: 8, result: "0x1" }, "TRANSPORT_ID_MISMATCH"],
    [{ jsonrpc: "2.0", id: 7, error: { code: -1 }, result: "0x1" }, "TRANSPORT_RPC_ERROR"],
    [{ jsonrpc: "2.0", id: 7 }, "TRANSPORT_RESULT_MISSING"]
  ];
  for (const [value, code] of invalid) assert.throws(() => scanner.decodeJsonRpcEnvelope(encode(value), 7), (error) => error.code === code);
  assert.throws(() => scanner.decodeJsonRpcEnvelope(Buffer.from("{"), 7), (error) => error.code === "TRANSPORT_JSON_INVALID");
  assert.throws(() => scanner.decodeJsonRpcEnvelope(Buffer.alloc(scanner.LIMITS.responseBytes + 1, 0x20), 7), (error) => error.code === "TRANSPORT_RESPONSE_CAP");
});

function fakeHttps(outcome) {
  return {
    request(_options, callback) {
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = outcome.status ?? 200; callback(response);
        for (const chunk of outcome.chunks || []) response.emit("data", Buffer.from(chunk));
        if (outcome.event) response.emit(outcome.event, new Error("fixture"));
        else if (!outcome.hang) response.emit("end");
      });
      return request;
    }
  };
}

test("production transport carries exact received bytes on every success and failure class", async () => {
  const handle = candidate(URLS.alchemy).handle;
  const successBody = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }));
  const success = await scanner.createHttpsTransport(fakeHttps({ chunks: [successBody] }))(handle, "eth_chainId", [], 50);
  assert.equal(success.wireBytes, successBody.length);
  const cases = [
    ["TRANSPORT_HTTP_STATUS", { status: 500, chunks: ["non-200-body"] }],
    ["TRANSPORT_JSON_INVALID", { chunks: ["{"] }],
    ["TRANSPORT_JSONRPC_VERSION_INVALID", { chunks: [JSON.stringify({ id: 1, result: "0x1" })] }],
    ["TRANSPORT_ID_MISMATCH", { chunks: [JSON.stringify({ jsonrpc: "2.0", id: 2, result: "0x1" })] }],
    ["TRANSPORT_RPC_ERROR", { chunks: [JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } })] }],
    ["TRANSPORT_RESULT_MISSING", { chunks: [JSON.stringify({ jsonrpc: "2.0", id: 1 })] }],
    ["TRANSPORT_PARTIAL_RESPONSE", { chunks: ["partial"], event: "error" }]
  ];
  for (const [code, outcome] of cases) {
    const expectedBytes = outcome.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
    await assert.rejects(() => scanner.createHttpsTransport(fakeHttps(outcome))(handle, "eth_chainId", [], 50), (error) => error.code === code && error.wireBytes === expectedBytes, code);
  }
  const partial = "partial-before-timeout";
  await assert.rejects(() => scanner.createHttpsTransport(fakeHttps({ chunks: [partial], hang: true }))(handle, "eth_chainId", [], 1), (error) => error.code === "TRANSPORT_TIMEOUT" && error.wireBytes === Buffer.byteLength(partial));
});

test("artifact sanitizer rejects forbidden classes and row identifiers", () => {
  const cases = [
    { endpointValue: "opaque" }, { safe: "rpc.example.com" }, { headers: { x: "y" } }, { credentials: "opaque" },
    { providerLabel: "provider-a" }, { operatorFamily: "family-a" }, { rawResponse: "opaque" }, { calldata: "0x1234" },
    { safe: ADDRESSES.reserve }, { transactionHash: `0x${"44".repeat(32)}` }, { blockHash: HASH }, { stateRoot: ROOT_HASH },
    { ordinal: 1 }, { rows: [] }, { tuple: [18, 18, 18] }
  ];
  for (const value of cases) assert.throws(() => scanner.assertSanitized(value), scanner.ScanError);
  assert.throws(() => scanner.assertSanitized({ safe: "inventory-secret" }, ["inventory-secret"]), scanner.ScanError);
});

test("published bytes are aggregate-only, sanitized, atomic, and no-overwrite", async () => {
  const result = await run({ storedDecimals: 78 });
  scanner.assertSanitized(result);
  const bytes = Buffer.from(`${JSON.stringify(result)}\n`), text = bytes.toString("utf8");
  assert.equal(/ordinal|rows|storedDecimals|liveDecimals|packedDecimals|https?:|0x[0-9a-f]{40}/iu.test(text), false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aave-decimals-r1-"));
  try {
    const output = path.join(directory, "result.json");
    scanner.publishNoOverwrite(output, bytes, fs, () => Buffer.alloc(8, 1));
    assert.throws(() => scanner.publishNoOverwrite(output, Buffer.from("changed"), fs, () => Buffer.alloc(8, 2)), (error) => error.code === "OUTPUT_ALREADY_EXISTS");
    assert.deepEqual(fs.readFileSync(output), bytes);
    assert.deepEqual(fs.readdirSync(directory), ["result.json"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("CLI disabled/argument gates and enabled stdout remain aggregate-only", async () => {
  let invoked = false, stdout = "", stderr = "";
  const disabled = await scanner.runCli({ argv: ["node", "scanner"], env: {}, stdout: { write: (value) => { stdout += value; } }, stderr: { write: (value) => { stderr += value; } }, runProduction: async () => { invoked = true; } });
  assert.equal(disabled, 0); assert.equal(invoked, false); assert.equal(JSON.parse(stdout).status, "CLI_DISABLED"); assert.equal(stderr, "");
  stderr = "";
  assert.equal(await scanner.runCli({ argv: ["node", "scanner", "arg"], env: {}, stdout: { write() {} }, stderr: { write: (value) => { stderr += value; } } }), 1);
  assert.equal(JSON.parse(stderr).code, "CLI_ARGUMENTS_FORBIDDEN");
  const report = await run({ storedDecimals: 78 }); stdout = "";
  const enabled = await scanner.runCli({ argv: ["node", "scanner"], env: { AAVE_RESERVE_DECIMALS_SCAN_R1: "1" }, stdout: { write: (value) => { stdout += value; } }, stderr: { write() {} }, runProduction: async () => report });
  assert.equal(enabled, 0);
  const line = JSON.parse(stdout);
  assert.deepEqual(Object.keys(line).sort(), ["counts", "finalizedBlockNumber", "signals", "status"]);
  assert.equal(/ordinal|address|https?:|0x[0-9a-f]{40}|provider|family|calldata|blockHash|stateRoot/iu.test(stdout), false);
});

test("output is deterministic apart from generatedAt and safety gates stay closed", async () => {
  const first = await run({ generatedAt: "2026-08-30T00:00:00.000Z" });
  const second = await run({ generatedAt: "2026-08-31T00:00:00.000Z" });
  assert.deepEqual(withoutGeneratedAt(first), withoutGeneratedAt(second));
  assert.deepEqual(first.gates, { automaticPromotion: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false });
  assert.equal(first.safety.retries, 0); assert.equal(first.safety.childProcesses, false); assert.equal(first.safety.environmentFilesRead, false);
});
