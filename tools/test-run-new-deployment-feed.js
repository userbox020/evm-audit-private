#!/usr/bin/env node
"use strict";
/*
 * tools/test-run-new-deployment-feed.js
 *
 * Offline node:test coverage for run-new-deployment-feed.js. No network access:
 * every case injects a mock RPC caller, a mock endpoint resolver, in-memory
 * URLs, and (where needed) an in-memory filesystem. It never runs --run-once
 * against a live endpoint.
 *
 * Run: node --test tools/test-run-new-deployment-feed.js
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const feed = require("./run-new-deployment-feed.js");

const TOPIC = "0x" + "a".repeat(64);
const TOPIC_B = "0x" + "b".repeat(64);
const ADDR_A = "0x1111111111111111111111111111111111111111";
const ADDR_B = "0x2222222222222222222222222222222222222222";
const ADDR_C = "0x3333333333333333333333333333333333333333";
const TX = "0x" + "c".repeat(64);
const HEAD = 0x100000; // 1048576

function word(address) {
  return "0x" + "0".repeat(24) + address.slice(2).toLowerCase();
}

function quantity(value) {
  return "0x" + BigInt(value).toString(16);
}

function factoryEntry(id, address, overrides = {}) {
  return { id, label: id, address, topic0: TOPIC, createdTopic: 1, createdIndex: 0, ...overrides };
}

function makeConfig(factoriesByChain) {
  return { version: 1, chains: factoriesByChain };
}

function logFor(address, blockNumber, overrides = {}) {
  return {
    address: ADDR_C,
    topics: [TOPIC, word(address)],
    data: "0x",
    blockNumber: quantity(blockNumber),
    transactionHash: TX,
    removed: false,
    ...overrides,
  };
}

// Mock RPC: returns results directly (matches shared-rpc's rpcCall contract).
function makeRpcCall(handlers = {}) {
  const calls = [];
  const rpcCall = async (url, method, params) => {
    calls.push({ method, params });
    if (typeof handlers[method] === "function") return handlers[method](params);
    if (method === "eth_blockNumber") return quantity(HEAD);
    if (method === "eth_getLogs") return [];
    throw new Error("unexpected-rpc-method");
  };
  rpcCall.calls = calls;
  return rpcCall;
}

function mockResolver() {
  return async (chainId) => `mock-rpc-${chainId}`;
}

function unusedFs() {
  return {
    statSync() { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    readFileSync() { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    mkdirSync() {},
    writeFileSync() { throw new Error("write-disabled"); },
  };
}

async function runOffline(config, handlers, extra = {}) {
  return feed.runFeed({
    config,
    urls: [],
    resolver: mockResolver(),
    rpcCall: makeRpcCall(handlers),
    now: Date.UTC(2026, 8, 14, 0, 0, 0),
    write: false,
    ...extra,
  });
}

/* ------------------------------------------------------------------ */
test("config validation accepts the shipped factory config", () => {
  const shipped = feed.loadConfig(path.join(__dirname, "new-deployment-factories.json"));
  const validated = feed.validateConfig(shipped);
  const entries = Object.values(validated.chains).flat();
  const chainCount = Object.keys(validated.chains).length;
  assert.equal(validated.version, 1);
  assert.ok(entries.length >= 5, "expected at least 5 factories");
  assert.ok(chainCount >= 2, "expected at least 2 chains");
  for (const entry of entries) {
    assert.match(entry.address, /^0x[0-9a-fA-F]{40}$/);
    assert.match(entry.topic0, /^0x[0-9a-fA-F]{64}$/);
  }
});

test("config validation rejects malformed factories", () => {
  assert.throws(() => feed.validateConfig(null), (e) => e.code === "INVALID_CONFIG");
  assert.throws(() => feed.validateConfig({ version: 2, chains: {} }), (e) => e.code === "UNSUPPORTED_CONFIG_VERSION");
  assert.throws(() => feed.validateConfig({ version: 1, chains: {} }), (e) => e.code === "EMPTY_CONFIG");
  assert.throws(
    () => feed.validateConfig(makeConfig({ "1": [factoryEntry("bad", "0xnothex")] })),
    (e) => e.code === "INVALID_FACTORY_ADDRESS");
  assert.throws(
    () => feed.validateConfig(makeConfig({ "1": [factoryEntry("bad", ADDR_A, { topic0: "0x1234" })] })),
    (e) => e.code === "INVALID_TOPIC0");
  assert.throws(
    () => feed.validateConfig(makeConfig({ "1": [factoryEntry("dup", ADDR_A), factoryEntry("dup", ADDR_B)] })),
    (e) => e.code === "DUPLICATE_FACTORY_ID");
  assert.throws(
    () => feed.validateConfig(makeConfig({ "1": [factoryEntry("url-label", ADDR_A, { label: "https://endpoint.example/rpc" })] })),
    (e) => e.code === "INVALID_FACTORY_LABEL");
});

test("decode: indexed topic1 address", () => {
  const entry = factoryEntry("f", ADDR_C);
  const decoded = feed.decodeCreatedAddress(logFor(ADDR_A, 100), entry);
  assert.equal(decoded, ADDR_A);
});

test("decode: data-encoded first address word when no topic1 is present", () => {
  const entry = factoryEntry("f", ADDR_C, { createdTopic: null });
  const log = {
    address: ADDR_C,
    topics: [TOPIC],
    data: word(ADDR_B) + "0".repeat(64),
    blockNumber: quantity(100),
    transactionHash: TX,
  };
  assert.equal(feed.decodeCreatedAddress(log, entry), ADDR_B);
});

test("decode: createdTopic=2 (second indexed argument)", () => {
  const entry = factoryEntry("f", ADDR_C, { createdTopic: 2, createdIndex: 1 });
  const log = logFor(ADDR_A, 100, { topics: [TOPIC, word(ADDR_C), word(ADDR_B)] });
  assert.equal(feed.decodeCreatedAddress(log, entry), ADDR_B);
});

test("decode: rejects address-shaped small integer in data", () => {
  const entry = factoryEntry("f", ADDR_C, { createdTopic: null });
  const smallInt = "0x" + "0".repeat(62) + "32"; // packed int24 tick, not an address
  const log = { topics: [TOPIC], data: smallInt, blockNumber: quantity(100), transactionHash: TX };
  assert.equal(feed.decodeCreatedAddress(log, entry), null);
});

test("run: window is capped at MAX_WINDOW_BLOCKS", async () => {
  const config = makeConfig({ "1": [factoryEntry("f", ADDR_C)] });
  const rpcCall = makeRpcCall({});
  const { artifact } = await feed.runFeed({
    config, urls: [], resolver: mockResolver(), rpcCall, write: false, windowBlocks: 9_999_999, now: 0,
  });
  assert.equal(artifact.windowBlocks, feed.MAX_WINDOW_BLOCKS);
  const getLogs = rpcCall.calls.find((c) => c.method === "eth_getLogs");
  const from = Number(BigInt(getLogs.params[0].fromBlock));
  const to = Number(BigInt(getLogs.params[0].toBlock));
  assert.equal(to, HEAD);
  assert.equal(to - from + 1, feed.MAX_WINDOW_BLOCKS);
});

test("run: dedupes the same created address across factories", async () => {
  const config = makeConfig({
    "1": [factoryEntry("f1", ADDR_C), factoryEntry("f2", ADDR_B, { topic0: TOPIC_B })],
  });
  const handlers = {
    eth_getLogs: (params) => {
      if (params[0].address === ADDR_C) return [logFor(ADDR_A, 100)];
      return [logFor(ADDR_A, 101, { topics: [TOPIC_B, word(ADDR_A)] })];
    },
  };
  const { artifact } = await runOffline(config, handlers);
  const candidates = artifact.chains.flatMap((c) => c.candidates);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].newAddress, ADDR_A);
  assert.equal(artifact.stats.duplicates, 1);
});

test("run: fail-closed isolation keeps other factories working", async () => {
  const config = makeConfig({ "1": [factoryEntry("failing", ADDR_C), factoryEntry("working", ADDR_B, { topic0: TOPIC_B })] });
  const handlers = {
    eth_getLogs: (params) => {
      if (params[0].address === ADDR_C) throw new Error("boom https://endpoint.example/rpc");
      return [logFor(ADDR_A, 100, { topics: [TOPIC_B, word(ADDR_A)] })];
    },
  };
  const { artifact } = await runOffline(config, handlers);
  assert.equal(artifact.stats.factoriesFailed, 1);
  assert.equal(artifact.stats.factoriesSucceeded, 1);
  assert.equal(artifact.failures.length, 1);
  assert.equal(artifact.failures[0].errorClass, "logs-unavailable");
  const candidates = artifact.chains.flatMap((c) => c.candidates);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].factoryId, "working");
});

test("run: head-unavailable fails every factory on the chain closed", async () => {
  const config = makeConfig({ "1": [factoryEntry("f1", ADDR_C), factoryEntry("f2", ADDR_B)] });
  const { artifact } = await runOffline(config, { eth_blockNumber: () => null });
  assert.equal(artifact.stats.factoriesSucceeded, 0);
  assert.equal(artifact.failures.length, 2);
  assert.ok(artifact.failures.every((f) => f.errorClass === "no-head"));
});

test("run: candidate caps are enforced and flagged as truncated", async () => {
  const config = makeConfig({ "1": [factoryEntry("f", ADDR_C)] });
  const handlers = {
    eth_getLogs: () => [
      logFor(ADDR_A, 100),
      logFor(ADDR_B, 101),
      logFor("0x4444444444444444444444444444444444444444", 102),
    ],
  };
  const { artifact } = await runOffline(config, handlers, { maxCandidatesPerFactory: 2 });
  assert.equal(artifact.chains[0].candidates.length, 2);
  assert.equal(artifact.stats.truncated, true);
});

test("run: block budget exhaustion is fail-closed but non-fatal", async () => {
  const config = makeConfig({
    "1": [factoryEntry("f1", ADDR_C), factoryEntry("f2", ADDR_B)],
    "8453": [factoryEntry("f3", ADDR_C)],
  });
  const { artifact } = await runOffline(config, {}, { maxTotalBlocks: 5000, windowBlocks: 5000 });
  assert.ok(artifact.stats.blocksScanned <= 5000);
  assert.ok(artifact.failures.some((f) => f.errorClass === "block-budget-exhausted"));
});

test("run: artifact is sanitized of endpoint-like fields and values", async () => {
  const config = makeConfig({ "1": [factoryEntry("f", ADDR_C)] });
  const { artifact } = await runOffline(config, { eth_getLogs: () => [logFor(ADDR_A, 100)] });
  assert.equal(artifact.schema, "new-deployment-feed/v1");
  assert.deepEqual(artifact.safety, {
    readOnly: true,
    networkAccess: true,
    signing: false,
    transactions: false,
    broadcast: false,
    endpointValuesPersisted: false,
    candidateAcquisitionOnly: true,
  });
  const serialized = JSON.stringify(artifact);
  assert.ok(!/https?:\/\//i.test(serialized), "artifact must not contain URLs");
  assert.ok(!/"(?:url|urls|endpoint|endpoints|rpc|rpcUrl|provider|secret|token|apiKey)"\s*:/i.test(serialized),
    "artifact must not contain endpoint-shaped keys");
  const redacted = feed.redactArtifact({ keep: 1, rpcUrl: "x", nested: { url: "y", note: "https://a.example/rpc" } });
  assert.deepEqual(redacted, { keep: 1, nested: { note: "[redacted]" } });
});

test("run: writes the artifact to the configured output path", async () => {
  const config = makeConfig({ "1": [factoryEntry("f", ADDR_C)] });
  const writes = new Map();
  const fsImpl = {
    statSync() { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    readFileSync() { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    mkdirSync() {},
    writeFileSync(target, data) { writes.set(target, data); },
  };
  const outputPath = path.join("reports", "monitor", "new-deployment-feed.json");
  const { written } = await feed.runFeed({
    config, urls: [], resolver: mockResolver(), rpcCall: makeRpcCall({ eth_getLogs: () => [] }),
    fs: fsImpl, outputPath, now: 0,
  });
  assert.equal(written, true);
  assert.ok(writes.has(outputPath));
  const parsed = JSON.parse(writes.get(outputPath));
  assert.equal(parsed.schema, "new-deployment-feed/v1");
});

test("run: loadConfig reads a bounded config from disk and rejects invalid JSON", () => {
  const good = JSON.stringify(makeConfig({ "1": [factoryEntry("f", ADDR_C)] }));
  const goodFs = {
    statSync: () => ({ isFile: () => true, size: Buffer.byteLength(good) }),
    readFileSync: () => good,
  };
  assert.equal(feed.loadConfig("config.json", goodFs).version, 1);

  const badFs = {
    statSync: () => ({ isFile: () => true, size: 3 }),
    readFileSync: () => "{ n",
  };
  assert.throws(() => feed.loadConfig("config.json", badFs), (e) => e.code === "CONFIG_INVALID_JSON");
});

test("cli: --run-once gates execution and parses bounds", () => {
  assert.equal(feed.cliGate([]).run, false);
  assert.equal(feed.cliGate(["--window-blocks=10"]).run, false);
  const gate = feed.cliGate(["--run-once", "--window-blocks=1234", "--max-candidates=7", "--out=tmp.json"]);
  assert.equal(gate.run, true);
  assert.equal(gate.args.windowBlocks, "1234");
  assert.equal(gate.args.maxCandidatesTotal, "7");
  assert.equal(gate.args.outputPath, "tmp.json");
  assert.ok(feed.USAGE.includes("--run-once"));
  assert.ok(feed.USAGE.includes("Read-only"));
});

test("run: never contacts the network or filesystem when write is disabled", async () => {
  const config = makeConfig({ "1": [factoryEntry("f", ADDR_C)] });
  const { artifact, written } = await feed.runFeed({
    config, urls: [], resolver: mockResolver(), rpcCall: makeRpcCall({}), fs: unusedFs(), write: false, now: 0,
  });
  assert.equal(written, false);
  assert.equal(artifact.windowBlocks, feed.DEFAULT_WINDOW_BLOCKS);
});
