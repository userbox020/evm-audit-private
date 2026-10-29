#!/usr/bin/env node
"use strict";

// Offline node:test suite for run-value-flow-cluster.js. No network access:
// resolveRpc and rpcCall are injected mocks. No live --run-once is executed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const scanner = require("./run-value-flow-cluster.js");

const BLOCK_HEX = "0x100";
const TS = 1_000_000n;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const D = "0x4444444444444444444444444444444444444444";
const E = "0x5555555555555555555555555555555555555555";
const URLS = Object.freeze({
  1: "https://mock-eth.invalid/secret-token",
  8453: "https://mock-base.invalid/secret-token"
});

function uintHex(value) { return `0x${BigInt(value).toString(16).padStart(64, "0")}`; }
function topicAddr(addr) { return `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`; }
function transfer(token, from, to, amount) {
  return {
    address: token.toLowerCase(),
    topics: [scanner.TRANSFER_TOPIC, topicAddr(from), topicAddr(to)],
    data: uintHex(amount)
  };
}
function chainOf(url) {
  for (const key of Object.keys(URLS)) if (URLS[key] === url) return Number(key);
  return null;
}

// Route table: tokenLower -> log[] | null (throws) | (filter) => log[] | null.
function tokenRoute(table) {
  return (filter) => {
    const entry = table[filter.address.toLowerCase()];
    if (entry === undefined) return [];
    if (typeof entry === "function") return entry(filter);
    if (entry === null) throw new Error("ROUTE_ERROR");
    return entry;
  };
}
function spanOf(filter) {
  const from = BigInt(filter.fromBlock);
  const to = BigInt(filter.toBlock);
  return to - from + 1n;
}

function buildConfig(extra = []) {
  return {
    schema: "value-flow-targets/v1",
    targets: [
      { id: "t-usdc", chainId: 1, token: USDC, decimals: 6, windowBlocks: 100, label: "test usdc", source: ["test fixture"] },
      { id: "t-weth", chainId: 1, token: WETH, decimals: 18, windowBlocks: 100, label: "test weth", source: ["test fixture"] },
      { id: "t-base", chainId: 8453, token: BASE_USDC, decimals: 6, windowBlocks: 100, label: "test base", source: ["test fixture"] },
      ...extra
    ]
  };
}

function mockOptions(routes, extra = {}) {
  const calls = [];
  const resolveRpc = async (chainId) => { calls.push({ kind: "resolve", chainId }); return URLS[chainId] || null; };
  const rpcCall = async (url, method, params) => {
    const chainId = chainOf(url);
    calls.push({ kind: "call", chainId, method, params });
    if (method === "eth_getBlockByNumber") {
      if (["finalized", "safe", "latest"].includes(params[0])) return { number: BLOCK_HEX, timestamp: `0x${TS.toString(16)}` };
      return null;
    }
    if (method === "eth_blockNumber") return BLOCK_HEX;
    if (method === "eth_getLogs") {
      const route = routes[chainId];
      if (!route) throw new Error("NO_ROUTE");
      return route(params[0]);
    }
    throw new Error("UNEXPECTED_METHOD");
  };
  return { calls, options: { resolveRpc, rpcCall, now: () => 1_700_000_000_000, ...extra } };
}
function assertSanitized(artifact) {
  const serialized = JSON.stringify(artifact);
  assert.equal(/https?:\/\//i.test(serialized), false);
  assert.equal(/mock-|secret-token|leak\.invalid|rpc_endpoints|api[_-]?key|private[_-]?key|mnemonic/i.test(serialized), false);
}
function tokenOf(artifact, id) {
  return artifact.chains.flatMap((chain) => chain.tokens).find((token) => token.id === id);
}

test("validateConfig accepts the shipped config and rejects malformed entries", () => {
  const file = path.join(__dirname, "value-flow-targets.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(scanner.validateConfig(config), true);
  assert.ok(config.targets.length >= 6);
  assert.deepEqual([...new Set(config.targets.map((entry) => entry.chainId))].sort((a, b) => a - b), [1, 8453, 42161]);
  assert.equal(config.targets.every((entry) => Array.isArray(entry.source) && entry.source.length > 0), true);

  const badSchema = structuredClone(config);
  badSchema.schema = "wrong/v1";
  assert.equal(scanner.validateConfig(badSchema), false);

  const badToken = structuredClone(config);
  badToken.targets[0].token = "0x1234";
  assert.equal(scanner.validateConfig(badToken), false);

  const wide = structuredClone(config);
  wide.targets[0].windowBlocks = scanner.MAX_WINDOW_BLOCKS + 1;
  assert.equal(scanner.validateConfig(wide), false);

  const noSource = structuredClone(config);
  noSource.targets[0].source = ["ok", 7];
  assert.equal(scanner.validateConfig(noSource), false);

  const duplicate = structuredClone(config);
  duplicate.targets[1].id = duplicate.targets[0].id;
  assert.equal(scanner.validateConfig(duplicate), false);

  assert.equal(scanner.validateConfig(buildConfig()), true);
});

test("Transfer logs decode and aggregate into inflow/outflow/net/gross/txCount", async () => {
  const routes = {
    1: tokenRoute({
      [USDC.toLowerCase()]: [
        transfer(USDC, A, B, 100), transfer(USDC, A, C, 50),
        transfer(USDC, B, A, 10), transfer(USDC, A, B, 20)
      ],
      [WETH.toLowerCase()]: []
    }),
    8453: tokenRoute({})
  };
  const { calls, options } = mockOptions(routes);
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(artifact), true);
  assert.equal(artifact.schema, "value-flow-cluster/v1");
  assert.equal(artifact.stats.targets, 3);
  assert.equal(artifact.stats.evaluated, 3);
  assert.equal(artifact.stats.failed, 0);

  const usdc = tokenOf(artifact, "t-usdc");
  assert.equal(usdc.token, USDC.toLowerCase());
  assert.equal(usdc.decimals, 6);
  assert.equal(usdc.window.blocks, 100);
  assert.equal(usdc.window.fromBlock, "157");
  assert.equal(usdc.window.toBlock, "256");
  assert.equal(usdc.window.chunkBlocks, 100);
  assert.equal(usdc.window.chunks, 1);
  assert.equal(usdc.window.logCount, 4);
  assert.equal(usdc.window.malformed, 0);

  assert.deepEqual(usdc.topInflow.map((row) => [row.address, row.inflow, row.txCount]), [
    [B, "120", 3], [C, "50", 1], [A, "10", 4]
  ]);
  assert.deepEqual(usdc.topOutflow.map((row) => [row.address, row.outflow, row.txCount]), [
    [A, "170", 4], [B, "10", 3], [C, "0", 1]
  ]);
  assert.deepEqual(usdc.topPairs.map((row) => [row.from, row.to, row.amount, row.txCount]), [
    [A, B, "120", 2], [A, C, "50", 1], [B, A, "10", 1]
  ]);
  assert.deepEqual(usdc.repeatNetPositive, [{ address: B, net: "110", grossFlow: "130", txCount: 3 }]);

  const weth = tokenOf(artifact, "t-weth");
  assert.equal(weth.window.logCount, 0);
  assert.deepEqual(weth.topInflow, []);
  assert.deepEqual(weth.repeatNetPositive, []);

  const logCalls = calls.filter((row) => row.method === "eth_getLogs");
  assert.equal(logCalls.every((row) => row.params[0].topics[0] === scanner.TRANSFER_TOPIC), true);
  assert.equal(logCalls.every((row) => row.params[0].toBlock === BLOCK_HEX), true);
  assert.equal(calls.filter((row) => row.method === "eth_getBlockByNumber").every((row) => row.params[0] === "finalized"), true);
  assertSanitized(artifact);
});

test("repeat-net-positive ranking honors minTx and sorts by net then grossFlow", async () => {
  const logs = [
    transfer(USDC, A, B, 100), transfer(USDC, A, B, 20), transfer(USDC, A, B, 30),
    transfer(USDC, B, C, 5), transfer(USDC, D, C, 6), transfer(USDC, E, C, 7)
  ];
  const routes = { 1: tokenRoute({ [USDC.toLowerCase()]: logs }), 8453: tokenRoute({}) };
  const { options } = mockOptions(routes);

  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  const usdc = tokenOf(artifact, "t-usdc");
  assert.deepEqual(usdc.repeatNetPositive.map((row) => [row.address, row.net, row.txCount]), [
    [B, "145", 4], [C, "18", 3]
  ]);
  assert.equal(artifact.stats.repeatNetPositive, 2);

  const strict = await scanner.runOnce({ ...options, config: buildConfig(), minTx: 5 });
  assert.deepEqual(tokenOf(strict, "t-usdc").repeatNetPositive, []);

  const low = await scanner.runOnce({ ...options, config: buildConfig(), minTx: 1 });
  // Low threshold admits high-count negative-net addresses? No: net > 0 is required.
  assert.equal(tokenOf(low, "t-usdc").repeatNetPositive.every((row) => BigInt(row.net) > 0n), true);
});

test("window is pre-chunked to chunkBlocks and spans aggregate across chunks", async () => {
  const routes = {
    1: tokenRoute({
      [USDC.toLowerCase()]: (filter) => (spanOf(filter) === 25n ? [transfer(USDC, A, B, 10)] : [])
    }),
    8453: tokenRoute({})
  };
  const { options } = mockOptions(routes, { chunkBlocks: 25 });
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  const usdc = tokenOf(artifact, "t-usdc");
  assert.equal(usdc.window.chunkBlocks, 25);
  assert.equal(usdc.window.chunks, 4);
  assert.equal(usdc.window.logCount, 4);
  assert.equal(usdc.repeatNetPositive[0].address, B);
  assert.equal(usdc.repeatNetPositive[0].net, "40");
});

test("provider range-limit splits a rejected chunk down without failing the token", async () => {
  const routes = {
    1: tokenRoute({
      [USDC.toLowerCase()]: (filter) => (spanOf(filter) > 50n ? null : [transfer(USDC, A, B, 10)])
    }),
    8453: tokenRoute({})
  };
  const { options } = mockOptions(routes, { chunkBlocks: 100 });
  const artifact = await scanner.runOnce({ ...options, config: buildConfig(), chunkBlocks: 100 });
  assert.equal(artifact.stats.failed, 0);
  assert.deepEqual(artifact.failures, []);
  const usdc = tokenOf(artifact, "t-usdc");
  assert.equal(usdc.window.chunks, 3); // 1 rejected parent + 2 accepted children
  assert.equal(usdc.window.logCount, 2);
});

test("malformed Transfer logs are skipped and counted, not fatal", async () => {
  const malformed = { address: USDC.toLowerCase(), topics: [scanner.TRANSFER_TOPIC, "0x00", topicAddr(B)], data: uintHex(1) };
  const badData = { address: USDC.toLowerCase(), topics: [scanner.TRANSFER_TOPIC, topicAddr(A), topicAddr(B)], data: "0x" };
  const routes = {
    1: tokenRoute({ [USDC.toLowerCase()]: [transfer(USDC, A, B, 5), malformed, badData] }),
    8453: tokenRoute({})
  };
  const { options } = mockOptions(routes);
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(artifact), true);
  const usdc = tokenOf(artifact, "t-usdc");
  assert.equal(usdc.window.logCount, 1);
  assert.equal(usdc.window.malformed, 2);
  assert.equal(artifact.stats.failed, 0);
});

test("one failing token is isolated and recorded fail-closed", async () => {
  const routes = {
    1: tokenRoute({ [USDC.toLowerCase()]: null, [WETH.toLowerCase()]: [transfer(WETH, A, B, 5)] }),
    8453: tokenRoute({ [BASE_USDC.toLowerCase()]: null })
  };
  const { options } = mockOptions(routes);
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(artifact), true);
  assert.deepEqual(artifact.failures.map((row) => [row.id, row.chainId, row.errorClass]), [
    ["t-usdc", 1, "ENTRY_FAILED"],
    ["t-base", 8453, "ENTRY_FAILED"]
  ]);
  assert.equal(artifact.stats.evaluated, 1);
  assert.deepEqual(artifact.chains.find((chain) => chain.chainId === 1).tokens.map((token) => token.id), ["t-weth"]);
  assert.deepEqual(artifact.chains.find((chain) => chain.chainId === 8453).tokens, []);
  assertSanitized(artifact);
});

test("missing endpoint fails closed without aborting the run", async () => {
  const routes = { 8453: tokenRoute({ [BASE_USDC.toLowerCase()]: [transfer(BASE_USDC, A, B, 1)] }) };
  const { options } = mockOptions(routes);
  options.resolveRpc = async (chainId) => (chainId === 1 ? null : URLS[chainId]);
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(artifact), true);
  assert.equal(artifact.chains.length, 1);
  assert.equal(artifact.chains[0].chainId, 8453);
  assert.equal(artifact.failures.filter((row) => row.chainId === 1).every((row) => row.errorClass === "ENDPOINT_UNAVAILABLE"), true);
  assert.equal(artifact.failures.length, 2);
});

test("global network call cap fail-closes entries without crashing", async () => {
  const routes = { 1: tokenRoute({ [USDC.toLowerCase()]: [transfer(USDC, A, B, 1)] }), 8453: tokenRoute({}) };
  const { calls, options } = mockOptions(routes);
  const artifact = await scanner.runOnce({ ...options, config: buildConfig(), maxNetworkCalls: 1 });
  assert.equal(scanner.validateArtifact(artifact), true);
  assert.ok(calls.filter((row) => row.kind === "call").length <= 1);
  assert.equal(artifact.failures.every((row) => row.errorClass === "RPC_CALL_CAP"), true);
  assert.ok(scanner.MAX_NETWORK_CALLS <= 256);
});

test("deep-redaction strips url-shaped values but preserves public token addresses", async () => {
  const config = buildConfig();
  config.targets[0].label = "usdc https://leak.invalid/secret-token";
  const routes = { 1: tokenRoute({ [USDC.toLowerCase()]: [transfer(USDC, A, B, 1)] }), 8453: tokenRoute({}) };
  const { options } = mockOptions(routes);
  const artifact = await scanner.runOnce({ ...options, config });
  assert.equal(scanner.validateArtifact(artifact), true);
  assertSanitized(artifact);
  assert.match(tokenOf(artifact, "t-usdc").label, /\[redacted-url\]/);
  assert.equal(JSON.stringify(artifact).includes(USDC.toLowerCase()), true);
});

test("--run-once gate: usage without the flag and run with it", async () => {
  assert.deepEqual(scanner.parseCli([]), { action: "usage", reason: "run-once-required" });
  assert.deepEqual(scanner.parseCli(["--run-once", "--bogus"]), { action: "usage", reason: "unknown-argument" });
  assert.deepEqual(scanner.parseCli(["--run-once"]), { action: "run", reason: "run-once" });

  const lines = [];
  const stdout = { write: (value) => { lines.push(value); } };
  const previous = process.exitCode;
  try {
    const usage = await scanner.main([], { stdout });
    assert.equal(usage.status, "USAGE");
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
    const ok = await scanner.main(["--run-once"], {
      stdout,
      runAndPublish: async () => ({ stats: { targets: 8, evaluated: 8, repeatNetPositive: 2, failed: 0 } })
    });
    assert.equal(ok.status, "OK");
    assert.equal(lines.some((line) => line.includes("run-once")), true);
  } finally {
    process.exitCode = previous;
  }
});

test("validateArtifact rejects tampered artifacts", async () => {
  const routes = { 1: tokenRoute({ [USDC.toLowerCase()]: [transfer(USDC, A, B, 1)] }), 8453: tokenRoute({}) };
  const { options } = mockOptions(routes);
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(artifact), true);

  const badSafety = structuredClone(artifact);
  badSafety.safety.signing = true;
  assert.equal(scanner.validateArtifact(badSafety), false);

  const badRow = structuredClone(artifact);
  badRow.chains[0].tokens[0].topInflow[0].net = "not-a-number";
  assert.equal(scanner.validateArtifact(badRow), false);

  const badWindow = structuredClone(artifact);
  badWindow.chains[0].tokens[0].window.blocks = scanner.MAX_WINDOW_BLOCKS + 1;
  assert.equal(scanner.validateArtifact(badWindow), false);

  const badFailure = structuredClone(artifact);
  badFailure.failures.push({ id: "x", chainId: 1, errorClass: "https://leak.invalid" });
  assert.equal(scanner.validateArtifact(badFailure), false);

  const leaky = structuredClone(artifact);
  leaky.chains[0].tokens[0].label = "https://leak.invalid/secret";
  assert.equal(scanner.validateArtifact(leaky), false);
});
