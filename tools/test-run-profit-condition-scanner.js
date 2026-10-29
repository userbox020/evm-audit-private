#!/usr/bin/env node
"use strict";

// Offline node:test suite for run-profit-condition-scanner.js. No network access:
// resolveRpc and rpcCall are injected mocks. No live --run-once is executed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AbiCoder } = require("ethers");
const scanner = require("./run-profit-condition-scanner.js");

const CODER = AbiCoder.defaultAbiCoder();
const TS = 1_000_000n;
const BLOCK_HEX = "0x100";
const URLS = Object.freeze({
  1: "https://mock-eth.invalid/secret-token",
  8453: "https://mock-base.invalid/secret-token"
});
const FEED = "0x1111111111111111111111111111111111111111";
const MARKET = "0x2222222222222222222222222222222222222222";
const P1 = "0x3333333333333333333333333333333333333333";
const P2 = "0x4444444444444444444444444444444444444444";
const VAULT = "0x5555555555555555555555555555555555555555";
const ARG = "0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

function uintHex(value) { return `0x${BigInt(value).toString(16).padStart(64, "0")}`; }
function feedHex(answer, updatedAt) {
  return CODER.encode(["uint80", "int256", "uint256", "uint256", "uint80"],
    [1n, BigInt(answer), 0n, BigInt(updatedAt), 1n]);
}
function chainOf(url) {
  for (const key of Object.keys(URLS)) if (URLS[key] === url) return Number(key);
  return null;
}

function buildConfig(extraTargets = []) {
  return {
    schema: "profit-scan-targets/v1",
    targets: [
      {
        id: "t-stale", chainId: 1, type: "stale-feed-capacity",
        reads: { feed: FEED, capacity: { target: MARKET, selector: "0x8285ef40" } },
        thresholds: { staleSeconds: 3600 }, label: "stale test"
      },
      {
        id: "t-div", chainId: 1, type: "oracle-divergence",
        reads: {
          p1: { target: P1, selector: scanner.FEED_SELECTOR, encoder: "feed", decimals: 8 },
          p2: { target: P2, selector: "0xb3596f07", encoder: "uint", decimals: 8, argWords: [ARG] }
        },
        thresholds: { divergenceBps: 100 }, label: "div test"
      },
      {
        id: "t-share", chainId: 1, type: "share-price-divergence",
        reads: {
          vault: VAULT, decimals: 18,
          reference: { value: "1000000000000000000", decimals: 18 }
        },
        thresholds: { divergenceBps: 50 }, label: "share test"
      },
      {
        id: "t-base", chainId: 8453, type: "stale-feed-capacity",
        reads: { feed: FEED, capacity: { target: MARKET, selector: "0x8285ef40" } },
        thresholds: { staleSeconds: 3600 }, label: "base stale test"
      },
      ...extraTargets
    ]
  };
}

// Scenario state per chain, resolved at call time so tests can mutate.
function makeRoutes(scenario) {
  return {
    1: (method, params) => routeEth1(scenario, method, params),
    8453: (method, params) => routeBase(scenario, method, params)
  };
}
function routeEth1(scenario, method, params) {
  if (method === "eth_getBlockByNumber") return { number: BLOCK_HEX, timestamp: `0x${TS.toString(16)}` };
  if (method !== "eth_call") throw new Error("UNEXPECTED_METHOD");
  const to = params[0].to.toLowerCase();
  const sel = params[0].data.slice(0, 10);
  if (to === FEED && sel === scanner.FEED_SELECTOR) return feedHex(scenario.answer, scenario.updatedAt);
  if (to === MARKET && sel === "0x8285ef40") {
    if (scenario.marketThrows) throw new Error("boom https://leak.invalid/secret-token");
    return uintHex(scenario.capacity);
  }
  if (to === P1 && sel === scanner.FEED_SELECTOR) return feedHex(scenario.p1, scenario.p1UpdatedAt);
  if (to === P2 && sel === "0xb3596f07") return uintHex(scenario.p2);
  if (to === VAULT && sel === "0x01e1d114") return uintHex(scenario.totalAssets);
  if (to === VAULT && sel === "0x18160ddd") return uintHex(scenario.totalSupply);
  throw new Error("UNEXPECTED_SELECTOR");
}
function routeBase(scenario, method, params) {
  if (method === "eth_getBlockByNumber") return { number: BLOCK_HEX, timestamp: `0x${TS.toString(16)}` };
  if (method !== "eth_call") throw new Error("UNEXPECTED_METHOD");
  const to = params[0].to.toLowerCase();
  const sel = params[0].data.slice(0, 10);
  if (to === FEED && sel === scanner.FEED_SELECTOR) return feedHex(scenario.baseAnswer, scenario.updatedAt);
  if (to === MARKET && sel === "0x8285ef40") return uintHex(scenario.capacity);
  throw new Error("UNEXPECTED_SELECTOR");
}
function defaults(overrides = {}) {
  return Object.assign({
    answer: 200000000000n, updatedAt: TS - 7200n, baseAnswer: 0n,
    capacity: 5000000000n, marketThrows: false,
    p1: 200000000000n, p1UpdatedAt: TS, p2: 200000000000n,
    totalAssets: 1000000000000000000000n, totalSupply: 1000000000000000000000n
  }, overrides);
}
function mockOptions(scenario, extra = {}) {
  const calls = [];
  const resolveRpc = async (chainId) => { calls.push({ kind: "resolve", chainId }); return URLS[chainId] || null; };
  const rpcCall = async (url, method, params) => {
    const chainId = chainOf(url);
    calls.push({ kind: "call", chainId, method, params });
    const routes = makeRoutes(scenario);
    const route = routes[chainId];
    if (!route) throw new Error("NO_ROUTE");
    return route(method, params);
  };
  return { calls, options: { resolveRpc, rpcCall, rpcUrls: [], now: () => 1_700_000_000_000, ...extra } };
}
function assertSanitized(artifact) {
  const serialized = JSON.stringify(artifact);
  assert.equal(/https?:\/\//i.test(serialized), false);
  assert.equal(/mock-|secret-token|leak\.invalid|rpc_endpoints|api[_-]?key|private[_-]?key|mnemonic/i.test(serialized), false);
}

test("validateConfig accepts the starter config file and rejects malformed entries", () => {
  const file = path.join(__dirname, "profit-scan-targets.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(scanner.validateConfig(config), true);
  assert.ok(config.targets.length >= 50, `expected >=50 entries, got ${config.targets.length}`);
  const chains = new Set(config.targets.map((entry) => entry.chainId));
  for (const chainId of [1, 8453, 42161, 10, 137, 56]) assert.ok(chains.has(chainId), `missing chain ${chainId}`);
  const types = new Set(config.targets.map((entry) => entry.type));
  for (const type of ["oracle-divergence", "stale-feed-capacity", "share-price-divergence"]) assert.ok(types.has(type));
  // Yield-bearing shortfall entries must not use a static parity reference.
  for (const entry of config.targets.filter((item) => item.reads.mode === "shortfall")) {
    assert.equal(entry.reads.reference.value, undefined, `${entry.id} uses static reference`);
    assert.ok(entry.reads.reference.target && entry.reads.reference.selector, `${entry.id} needs on-chain reference`);
  }
  // Every entry carries a local source citation.
  for (const entry of config.targets) assert.ok(Array.isArray(entry.source) && entry.source.length > 0, `${entry.id} missing source`);

  const badSchema = structuredClone(config);
  badSchema.schema = "wrong/v1";
  assert.equal(scanner.validateConfig(badSchema), false);

  const badType = structuredClone(config);
  badType.targets[0].type = "unknown-type";
  assert.equal(scanner.validateConfig(badType), false);

  const badAddress = structuredClone(config);
  badAddress.targets[0].reads.feed = "0x1234";
  assert.equal(scanner.validateConfig(badAddress), false);

  const duplicate = structuredClone(config);
  duplicate.targets[1].id = duplicate.targets[0].id;
  assert.equal(scanner.validateConfig(duplicate), false);

  assert.equal(scanner.validateConfig(buildConfig()), true);
});

test("full run ranks and emits stale+capacity, divergence, share-price, and invalid-answer flags", async () => {
  const { options } = mockOptions(defaults({
    capacity: 5000000000n,          // stale (age 7200 > 3600) AND capacity > 0
    p1: 200000000000n,             // 2000e8
    p2: 210000000000n,             // 2100e8 -> ~476 bps
    totalAssets: 1100000000000000000000n, // pps 1.1 vs ref 1.0 -> 1000 bps
    totalSupply: 1000000000000000000000n
  }));
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(artifact), true);
  assert.equal(artifact.schema, "profit-condition-scan/v1");
  assert.equal(artifact.chains.length, 2);
  assert.equal(artifact.stats.targets, 4);
  assert.equal(artifact.stats.flagged, 4);
  assert.equal(artifact.stats.failed, 0);

  const eth = artifact.chains.find((chain) => chain.chainId === 1);
  assert.equal(eth.blockNumber, String(BigInt(BLOCK_HEX)));
  assert.equal(eth.blockTimestamp, TS.toString());
  assert.equal(eth.blockTag, "finalized");
  assert.deepEqual(eth.flags.map((flag) => flag.id), ["t-stale", "t-div", "t-share"]);
  assert.equal(eth.flags[0].status, "STALE_FEED_WITH_CAPACITY");
  assert.equal(eth.flags[0].metrics.capacity, "5000000000");
  assert.equal(eth.flags[1].status, "ORACLE_DIVERGENCE");
  assert.equal(eth.flags[2].status, "SHARE_PRICE_DIVERGENCE");

  const base = artifact.chains.find((chain) => chain.chainId === 8453);
  assert.equal(base.flags[0].status, "FEED_ANSWER_INVALID");
  assertSanitized(artifact);
});

test("feed conditions: invalid answer, zero updatedAt, and stale without capacity", async () => {
  const below = mockOptions(defaults({ answer: 0n }));
  const zeroTs = mockOptions(defaults({ answer: 100n, updatedAt: 0n }));
  const noCap = mockOptions(defaults({ answer: 100n, capacity: 0n }));

  const a = await scanner.runOnce({ ...below.options, config: buildConfig() });
  const b = await scanner.runOnce({ ...zeroTs.options, config: buildConfig() });
  const c = await scanner.runOnce({ ...noCap.options, config: buildConfig() });

  const statusOf = (artifact, id) => artifact.chains.flatMap((chain) => chain.flags).find((flag) => flag.id === id).status;
  assert.equal(statusOf(a, "t-stale"), "FEED_ANSWER_INVALID");
  assert.equal(statusOf(b, "t-stale"), "FEED_ANSWER_INVALID");
  assert.equal(statusOf(c, "t-stale"), "FEED_STALE_NO_CAPACITY");
  assert.equal(statusOf(c, "t-base"), "FEED_ANSWER_INVALID");
});

test("oracle divergence math normalizes decimals and honors the bps threshold", async () => {
  // Equal raw value at equal decimals -> aligned.
  const aligned = mockOptions(defaults({ p1: 200000000000n, p2: 200000000000n }));
  const ethAligned = await scanner.runOnce({ ...aligned.options, config: buildConfig() });
  let flag = ethAligned.chains.find((c) => c.chainId === 1).flags.find((f) => f.id === "t-div");
  assert.equal(flag.status, "ORACLE_ALIGNED");
  assert.equal(flag.metrics.divergenceBps, "0");

  // 1000x mismatch (p1 = 1000 * p2) -> 999 * 10000 bps.
  const skewed = mockOptions(defaults({ p1: 200000000000n, p2: 200000000n }));
  const ethSkewed = await scanner.runOnce({ ...skewed.options, config: buildConfig() });
  flag = ethSkewed.chains.find((c) => c.chainId === 1).flags.find((f) => f.id === "t-div");
  assert.equal(flag.status, "ORACLE_DIVERGENCE");
  assert.equal(flag.metrics.divergenceBps, "9990000");

  // Decimal-aware config: p2 has 18 decimals, p1 has 8; equal economic value -> aligned.
  const config = buildConfig();
  config.targets.find((t) => t.id === "t-div").reads.p2.decimals = 18;
  const mixed = mockOptions(defaults({ p1: 200000000000n, p2: 2000000000000000000000n }));
  const ethMixed = await scanner.runOnce({ ...mixed.options, config });
  flag = ethMixed.chains.find((c) => c.chainId === 1).flags.find((f) => f.id === "t-div");
  assert.equal(flag.status, "ORACLE_ALIGNED");
  assert.equal(flag.metrics.divergenceBps, "0");
});

test("share-price condition flags divergence from reference and aligns at parity", async () => {
  const diverge = mockOptions(defaults({
    totalAssets: 1050000000000000000000n, totalSupply: 1000000000000000000000n
  }));
  const aligned = mockOptions(defaults({
    totalAssets: 1001000000000000000000n, totalSupply: 1000000000000000000000n
  }));
  const a = await scanner.runOnce({ ...diverge.options, config: buildConfig() });
  const b = await scanner.runOnce({ ...aligned.options, config: buildConfig() });
  const find = (artifact) => artifact.chains.find((c) => c.chainId === 1).flags.find((f) => f.id === "t-share");
  assert.equal(find(a).status, "SHARE_PRICE_DIVERGENCE");
  assert.equal(find(a).metrics.divergenceBps, "500");
  assert.equal(find(a).metrics.pricePerShare, "1050000000000000000");
  assert.equal(find(b).status, "SHARE_PRICE_ALIGNED");
  assert.equal(find(b).metrics.divergenceBps, "10");
});

test("share-price shortfall mode ignores accrued yield above reference and flags real shortfalls", async () => {
  const config = buildConfig();
  config.targets = config.targets.filter((entry) => entry.id === "t-share");
  config.targets[0].reads = {
    vault: VAULT, decimals: 18, mode: "shortfall",
    reference: { value: "1000000000000000000", decimals: 18 }
  };

  // Yield-bearing vault above parity (accrued yield) must NOT flag.
  const above = mockOptions(defaults({
    totalAssets: 1109570935690091331000n, totalSupply: 1000000000000000000000n
  }));
  const a = await scanner.runOnce({ ...above.options, config });
  assert.equal(scanner.validateArtifact(a), true);
  assert.equal(a.chains[0].flags[0].status, "SHARE_PRICE_ALIGNED");
  assert.equal(a.chains[0].flags[0].metrics.mode, "shortfall");
  assert.equal(a.chains[0].flags[0].metrics.direction, "above");
  assert.equal(a.stats.flagged, 0);

  // A genuine shortfall below the reference path MUST flag.
  const below = mockOptions(defaults({
    totalAssets: 950000000000000000000n, totalSupply: 1000000000000000000000n
  }));
  const b = await scanner.runOnce({ ...below.options, config });
  assert.equal(scanner.validateArtifact(b), true);
  assert.equal(b.chains[0].flags[0].status, "SHARE_PRICE_DIVERGENCE");
  assert.equal(b.chains[0].flags[0].metrics.direction, "below");
  assert.equal(b.chains[0].flags[0].metrics.divergenceBps, "500");
  assert.equal(b.stats.flagged, 1);
});

test("share-price divergence mode still flags two-sided deviations", async () => {
  // Default mode (no `mode`) remains two-sided for non-yield-bearing NAV checks.
  const { options } = mockOptions(defaults({
    totalAssets: 950000000000000000000n, totalSupply: 1000000000000000000000n
  }));
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  const share = artifact.chains.find((chain) => chain.chainId === 1).flags.find((flag) => flag.id === "t-share");
  assert.equal(share.status, "SHARE_PRICE_DIVERGENCE");
  assert.equal(share.metrics.mode, "divergence");
  assert.equal(share.metrics.direction, "below");
});

test("block pinning falls back across finalized/safe/latest and numeric references", async () => {
  const scenario = defaults({ baseAnswer: 100n });
  const makeOptions = (behavior) => {
    const calls = [];
    return {
      calls,
      options: {
        resolveRpc: async (chainId) => URLS[chainId] || null,
        rpcUrls: [],
        rpcCall: async (url, method, params) => {
          const chainId = chainOf(url);
          calls.push({ chainId, method, params });
          if (method === "eth_getBlockByNumber") return behavior(params[0]);
          if (method === "eth_blockNumber") return behavior("NUMBER");
          if (method !== "eth_call") throw new Error("UNEXPECTED_METHOD");
          const routes = makeRoutes(scenario);
          return routes[chainId](method, params);
        },
        now: () => 1_700_000_000_000
      }
    };
  };

  // finalized and safe unsupported -> latest is used and recorded.
  const latest = makeOptions((ref) => (ref === "latest" ? { number: "0xabc", timestamp: "0xf4240" } : null));
  const a = await scanner.runOnce({ ...latest.options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(a), true);
  assert.equal(a.chains.length, 2);
  assert.equal(a.chains.every((chain) => chain.blockTag === "latest"), true);
  assert.equal(a.chains[0].blockNumber, String(BigInt("0xabc")));
  const readBlocks = latest.calls.filter((row) => row.method === "eth_call").map((row) => row.params[1]);
  assert.equal(readBlocks.every((block) => block === "0xabc"), true);

  // No tag supported -> eth_blockNumber numeric reference is used and recorded.
  const numeric = makeOptions((ref) => {
    if (ref === "NUMBER") return "0xabc";
    if (ref === "0xabc") return { number: "0xabc", timestamp: "0xf4240" };
    return null;
  });
  const b = await scanner.runOnce({ ...numeric.options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(b), true);
  assert.equal(b.chains.every((chain) => chain.blockTag === "0xabc"), true);
  assert.equal(b.failures.length, 0);
});

test("multi-candidate transport rotates a flaky endpoint and records the family count", async () => {
  const A = "https://mock-a.invalid/x";
  const B = "https://mock-b.invalid/x";
  const calls = [];
  const config = {
    schema: "profit-scan-targets/v1",
    targets: [{
      id: "t-multi", chainId: 1, type: "stale-feed-capacity",
      reads: { feed: FEED, capacity: { target: MARKET, selector: "0x8285ef40" } },
      thresholds: { staleSeconds: 3600 }, label: "multi candidate"
    }]
  };
  const options = {
    config,
    rpcUrls: [A, B],
    resolveRpc: async (chainId, remaining) => (Array.isArray(remaining) && remaining.length ? remaining[0] : null),
    rpcCall: async (url, method, params) => {
      calls.push({ url, method });
      if (url === A) return null; // flaky/partial endpoint returns nothing
      if (method === "eth_getBlockByNumber") return { number: "0x100", timestamp: `0x${TS.toString(16)}` };
      if (method === "eth_call") {
        const sel = params[0].data.slice(0, 10);
        if (sel === scanner.FEED_SELECTOR) return feedHex(100n, TS - 7200n);
        if (sel === "0x8285ef40") return uintHex(5000000000n);
      }
      return null;
    },
    now: () => 1_700_000_000_000
  };
  const artifact = await scanner.runOnce(options);
  assert.equal(scanner.validateArtifact(artifact), true);
  assert.equal(artifact.chains.length, 1);
  assert.equal(artifact.chains[0].blockTag, "finalized");
  assert.equal(artifact.chains[0].candidateFamilies, 2);
  assert.equal(artifact.chains[0].flags[0].status, "STALE_FEED_WITH_CAPACITY");
  assert.equal(calls.some((row) => row.url === A), true);
  assert.equal(calls.some((row) => row.url === B), true);
  assertSanitized(artifact);
});

test("one failing entry does not abort others and is recorded fail-closed", async () => {
  const scenario = defaults({ marketThrows: true, baseAnswer: 100n });
  const { options } = mockOptions(scenario);
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(artifact), true);
  const eth = artifact.chains.find((chain) => chain.chainId === 1);
  const stale = eth.flags.find((flag) => flag.id === "t-stale");
  assert.equal(stale.status, "FAILED");
  assert.equal(stale.metrics.errorClass, "ENTRY_FAILED");
  assert.deepEqual(eth.flags.find((flag) => flag.id === "t-div").status, "ORACLE_ALIGNED");
  const base = artifact.chains.find((chain) => chain.chainId === 8453);
  assert.equal(base.flags.find((flag) => flag.id === "t-base").status, "STALE_FEED_WITH_CAPACITY");
  assert.equal(artifact.failures.some((row) => row.id === "t-stale"), true);
  assert.equal(artifact.stats.failed, 1);
  assertSanitized(artifact);
});

test("missing endpoint fails closed without aborting the run", async () => {
  const { options } = mockOptions(defaults({ baseAnswer: 100n }));
  options.resolveRpc = async (chainId) => (chainId === 1 ? null : URLS[chainId]);
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(artifact), true);
  assert.equal(artifact.chains.length, 1);
  assert.equal(artifact.failures.filter((row) => row.chainId === 1).every((row) => row.errorClass === "ENDPOINT_UNAVAILABLE"), true);
  assert.equal(artifact.chains[0].flags[0].status, "STALE_FEED_WITH_CAPACITY");
});

test("deep-redaction strips url/endpoint-shaped keys and values", async () => {
  const config = buildConfig();
  config.targets[0].label = "stale https://leak.invalid/secret-token";
  const scenario = defaults({ marketThrows: true });
  const { options } = mockOptions(scenario);
  const artifact = await scanner.runOnce({ ...options, config });
  assert.equal(scanner.validateArtifact(artifact), true);
  assertSanitized(artifact);
  const stale = artifact.chains.find((chain) => chain.chainId === 1).flags.find((flag) => flag.id === "t-stale");
  assert.match(stale.label, /\[redacted-url\]/);
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
    const ok = await scanner.main(["--run-once"], { stdout, runAndPublish: async () => ({ stats: { targets: 8, flagged: 0, failed: 0 } }) });
    assert.equal(ok.status, "OK");
    assert.equal(lines.some((line) => line.includes("run-once")), true);
  } finally {
    process.exitCode = previous;
  }
});

test("network call cap fail-closes entries without crashing the run", async () => {
  const { options, calls } = mockOptions(defaults());
  const artifact = await scanner.runOnce({ ...options, config: buildConfig(), maxNetworkCalls: 1 });
  assert.equal(scanner.validateArtifact(artifact), true);
  const callCount = calls.filter((row) => row.kind === "call").length;
  assert.ok(callCount <= 1);
  const statuses = artifact.chains.flatMap((chain) => chain.flags).map((flag) => flag.status);
  assert.equal(statuses.includes("FAILED"), true);
  assert.equal(artifact.failures.some((row) => row.errorClass === "RPC_CALL_CAP"), true);
  assert.ok(scanner.MAX_NETWORK_CALLS <= 128);
});

test("all chain reads use the same pinned block number", async () => {
  const { options, calls } = mockOptions(defaults({ baseAnswer: 100n }));
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(artifact), true);
  const callBlocks = calls.filter((row) => row.kind === "call" && row.method === "eth_call")
    .map((row) => row.params[1]);
  assert.ok(callBlocks.length > 0);
  assert.equal(callBlocks.every((block) => block === BLOCK_HEX), true);
  const pins = calls.filter((row) => row.kind === "call" && row.method === "eth_getBlockByNumber");
  assert.equal(pins.length, 2);
  assert.equal(pins.every((row) => row.params[0] === "finalized"), true);
});

test("validateArtifact rejects tampered artifacts", async () => {
  const { options } = mockOptions(defaults());
  const artifact = await scanner.runOnce({ ...options, config: buildConfig() });
  assert.equal(scanner.validateArtifact(artifact), true);

  const badSafety = structuredClone(artifact);
  badSafety.safety.signing = true;
  assert.equal(scanner.validateArtifact(badSafety), false);

  const badStatus = structuredClone(artifact);
  badStatus.chains[0].flags[0].status = "MADE_UP";
  assert.equal(scanner.validateArtifact(badStatus), false);

  const badMetrics = structuredClone(artifact);
  badMetrics.chains[0].flags[0].metrics = [];
  assert.equal(scanner.validateArtifact(badMetrics), false);

  const badFailure = structuredClone(artifact);
  badFailure.failures.push({ id: "x", chainId: 1, errorClass: "https://leak.invalid" });
  assert.equal(scanner.validateArtifact(badFailure), false);

  const leaky = structuredClone(artifact);
  leaky.chains[0].flags[0].label = "https://leak.invalid/secret";
  assert.equal(scanner.validateArtifact(leaky), false);
});
