#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const producer = require("./run-profit-trigger-watch.js");
const autopilot = require("./trigger-fork-autopilot.js");
const bridge = require("./run-trigger-fork-poc.js");
const deadline = require("./lib/producer-deadline.js");

const FIXED_NOW = 1_700_000_000_000;
const URLS = Object.freeze({
  1: "https://mock-eth.invalid/secret-token",
  8453: "https://mock-base.invalid/secret-token",
  42161: "https://mock-arb.invalid/secret-token"
});
const ADDR_A = "0x1111111111111111111111111111111111111111";
const ADDR_B = "0x2222222222222222222222222222222222222222";
const ADDR_STRATEGY = producer.STRATEGY_BASELINE[0];

function word(value) { return BigInt(value).toString(16).padStart(64, "0"); }
function uint(value) { return `0x${word(value)}`; }
function intHex(value) {
  let raw = BigInt(value);
  if (raw < 0n) raw += 1n << 256n;
  return `0x${raw.toString(16).padStart(64, "0")}`;
}
function boolHex(value) { return uint(value ? 1n : 0n); }
function addressWord(value) { return value.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }
function arrayWords(items) { return word(items.length) + items.map((value) => word(value)).join(""); }
function arrayAddresses(items) { return word(items.length) + items.map(addressWord).join(""); }
// Returns (uint256[], address[], address[], address[]); only the first address
// array (offset index 1) carries the active strategy set.
function strategiesHex(strategies) {
  const ids = arrayWords([1n]);
  const active = arrayAddresses(strategies);
  const second = arrayAddresses([ADDR_B]);
  const third = arrayAddresses([ADDR_A]);
  const offset0 = 128;
  const offset1 = offset0 + ids.length / 2;
  const offset2 = offset1 + active.length / 2;
  const offset3 = offset2 + second.length / 2;
  return `0x${word(offset0)}${word(offset1)}${word(offset2)}${word(offset3)}${ids}${active}${second}${third}`;
}
function chainOf(url) {
  for (const key of Object.keys(URLS)) if (URLS[key] === url) return Number(key);
  return null;
}
function crossDexArtifact(status = "NO_GROSS_EDGE") {
  const rows = Array.from({ length: 8 }, (_, index) => ({
    status, routeKey: `${index}`.padStart(64, "a"), eventId: `${index}`.padStart(64, "b"),
    direction: index % 2 ? "UNIV3_TO_CURVE" : "CURVE_TO_UNIV3",
    amountInRaw: "100000000", expectedOutRaw: status === "ATOMIC_FORK_REQUIRED" ? "103000000" : "99000000",
    grossDeltaRaw: status === "ATOMIC_FORK_REQUIRED" ? "3000000" : "-1000000",
    gasCeilingUsdcRaw: "2000000",
  }));
  const fired = rows.filter((row) => row.status === "ATOMIC_FORK_REQUIRED");
  return {
    pin: { number: 123, hash: `0x${"1".repeat(64)}`, timestamp: new Date(FIXED_NOW).toISOString(), baseFeePerGasRaw: "1000000000" },
    oracle: { ethUsdRaw: "200000000000" },
    economics: { rows, fired },
    forkCandidates: fired.map((row) => ({
      routeKey: row.routeKey, eventId: row.eventId, direction: row.direction, amountInRaw: row.amountInRaw,
      expectedOutRawAtPin: row.expectedOutRaw, grossDeltaRawAtPin: row.grossDeltaRaw,
      gasCeilingUsdcRaw: row.gasCeilingUsdcRaw,
      curve: { pool: "0xdcef968d416a41cdac0ed8702fac8128a64241a2" },
      uniswapV3: { pool: "0xc63b0708e2f7e69cb8a1df0e1389a98c35a76d52" },
    })),
  };
}

function failedCrossDexArtifact() {
  const artifact = crossDexArtifact("FAILED");
  // Match the economics rows emitted for incomplete scanner quotes.
  artifact.economics.rows = artifact.economics.rows.map((row) => ({
    status: "FAILED", routeKey: null, eventId: null,
    direction: row.direction, amountInRaw: row.amountInRaw,
    expectedOutRaw: null, grossDeltaRaw: null, morphoPremiumRaw: "0",
    gasCeilingUsdcRaw: null, effectiveGasPriceWei: null, routePositive: "unknown",
  }));
  return artifact;
}

function exhaustedBalancerArtifact() {
  const artifact = failedCrossDexArtifact();
  // Match the scanner shape: diagnostics live outside the flattened economics.
  artifact.economics.rows.forEach((row, index) => { row.amountInRaw = String([10, 25, 50, 100][Math.floor(index / 2)] * 1e6); });
  artifact.rows = artifact.economics.rows.map(row => ({
    direction: row.direction, amountInRaw: row.amountInRaw, economics: { ...row },
    liquidityDiagnostic: { inputReserveRaw: row.direction === "CURVE_TO_UNIV3" ? "1" : "174",
      outputReserveRaw: row.direction === "CURVE_TO_UNIV3" ? "174" : "1", inputExceedsRegisteredReserve: true },
  }));
  return artifact;
}

function joinExitArtifact(status = "NO_GROSS_EDGE") {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    status, routeKey: `${index}`.padStart(64, "c"), eventId: `${index}`.padStart(64, "d"),
    direction: index % 2 ? "JOIN_EXIT_USDT" : "JOIN_EXIT_USDC",
    amountInRaw: "100000000", expectedOutRaw: status === "ATOMIC_FORK_REQUIRED" ? "103000000" : "99000000",
    grossDeltaRaw: status === "ATOMIC_FORK_REQUIRED" ? "3000000" : "-1000000",
    gasCeilingUsdcRaw: "2000000",
  }));
  const fired = rows.filter((row) => row.status === "ATOMIC_FORK_REQUIRED");
  return {
    pin: { number: 123, hash: `0x${"1".repeat(64)}`, timestamp: new Date(FIXED_NOW).toISOString(), baseFeePerGasRaw: "1000000000" },
    oracle: { ethUsdRaw: "200000000000" },
    economics: { rows, fired },
    forkCandidates: fired.map((row) => ({
      routeKey: row.routeKey, eventId: row.eventId, direction: row.direction, amountInRaw: row.amountInRaw,
      expectedOutRawAtPin: row.expectedOutRaw, grossDeltaRawAtPin: row.grossDeltaRaw,
      gasCeilingUsdcRaw: row.gasCeilingUsdcRaw,
      pool: "0x06df3b2bbb68adc8b0e302443692037ed9f91b42",
      poolId: "0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063",
      vault: "0xba12222222228d8ba445958a75a0704d566bf2c8",
    })),
  };
}

function curveJoinExitArtifact(status = "NO_GROSS_EDGE", rowCount = 8, directions = ["ADD_REMOVE_FRAX", "ADD_REMOVE_USDC"]) {
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    status, routeKey: `${index}`.padStart(64, "e"), eventId: `${index}`.padStart(64, "f"),
    direction: directions[index % directions.length],
    amountInRaw: "100000000", expectedOutRaw: status === "ATOMIC_FORK_REQUIRED" ? "103000000" : "99000000",
    grossDeltaRaw: status === "ATOMIC_FORK_REQUIRED" ? "3000000" : "-1000000",
    gasCeilingUsdcRaw: "2000000",
  }));
  const fired = rows.filter((row) => row.status === "ATOMIC_FORK_REQUIRED");
  return {
    pin: { number: 123, hash: `0x${"1".repeat(64)}`, timestamp: new Date(FIXED_NOW).toISOString(), baseFeePerGasRaw: "1000000000" },
    oracle: { ethUsdRaw: "200000000000" },
    economics: { rows, fired },
    forkCandidates: fired.map((row) => ({
      routeKey: row.routeKey, eventId: row.eventId, direction: row.direction, amountInRaw: row.amountInRaw,
      expectedOutRawAtPin: row.expectedOutRaw, grossDeltaRawAtPin: row.grossDeltaRaw,
      gasCeilingUsdcRaw: row.gasCeilingUsdcRaw,
      pool: "0xdcef968d416a41cdac0ed8702fac8128a64241a2",
      lpToken: "0x3175df0976dfa876431c2e9ee6bc45b65d3473cc",
    })),
  };
}

function kelpBaseRoute({ poolPaused, rate = 123n, wrapperSupply = 456n }) {
  return (method, params) => {
    if (method !== "eth_call") throw new Error("UNEXPECTED_METHOD");
    const to = params[0].to.toLowerCase();
    const selector = params[0].data.slice(0, 10);
    if (to === producer.ADDRESSES.kelpBasePool) {
      if (selector === producer.SELECTOR.paused) return boolHex(poolPaused);
      if (selector === producer.SELECTOR.getRate) return uint(rate);
    }
    if (to === producer.ADDRESSES.kelpBaseWrapper && selector === producer.SELECTOR.totalSupply) return uint(wrapperSupply);
    throw new Error("UNEXPECTED_SELECTOR");
  };
}
function ethRoute({ strategies = [ADDR_STRATEGY], rsethPaused = false, maxMint = 0n, currentMinted = 0n } = {}) {
  return (method, params) => {
    if (method !== "eth_call") throw new Error("UNEXPECTED_METHOD");
    const to = params[0].to.toLowerCase();
    const selector = params[0].data.slice(0, 10);
    if (to === producer.ADDRESSES.metaClever && selector === producer.SELECTOR.getActiveYieldStrategies) {
      return strategiesHex(strategies);
    }
    if (to === producer.ADDRESSES.rseth) {
      if (selector === producer.SELECTOR.paused) return boolHex(rsethPaused);
      if (selector === producer.SELECTOR.maxMintAmountPerDay) return uint(maxMint);
      if (selector === producer.SELECTOR.currentPeriodMintedAmount) return uint(currentMinted);
    }
    throw new Error("UNEXPECTED_SELECTOR");
  };
}
function ostiumRoute({ maxInterval, lastTs, nowTs, openPnl = 0n, price = 0n }) {
  return (method, params) => {
    if (method === "eth_getBlockByNumber") return { number: "0x100", timestamp: `0x${BigInt(nowTs).toString(16)}` };
    if (method !== "eth_call") throw new Error("UNEXPECTED_METHOD");
    const selector = params[0].data.slice(0, 10);
    if (selector === producer.SELECTOR.maxSettlementInterval) return uint(maxInterval);
    if (selector === producer.SELECTOR.lastSettlementTs) return uint(lastTs);
    if (selector === producer.SELECTOR.getOpenPnlWithRollover) return intHex(openPnl);
    if (selector === producer.SELECTOR.lastTradePrice) return intHex(price);
    throw new Error("UNEXPECTED_SELECTOR");
  };
}
function morphoLArtifact(liquidatable = 0) {
  return {
    pin: { number: 123, hash: `0x${"9".repeat(64)}`, timestamp: new Date(FIXED_NOW).toISOString(), baseFeePerGasRaw: "1000000000" },
    totals: { exactLiquidatable: liquidatable, activeEvaluated: 1, rawDirectionalLiquidatable: liquidatable, oracleUnavailable: 0 },
    valuation: { status: liquidatable > 0 ? "UNQUALIFIED_ROUTE" : "NO_CANDIDATE" },
    reads: { failed: 0 },
  };
}
function aaveOfResult(chainId) {
  return {
    artifact: {
      pin: { number: 123, hash: `0x${"a".repeat(64)}`, timestamp: new Date(FIXED_NOW).toISOString() },
      reservesObserved: 5,
    },
    anomalies: [],
    binder: {},
    triggerClass: "O",
    config: { chainId },
  };
}
function aaveLArtifact(liquidatable = 0) {
  return {
    pin: { number: 123, hash: `0x${"b".repeat(64)}`, timestamp: new Date(FIXED_NOW).toISOString() },
    totals: { exactLiquidatable: liquidatable, activeAccounts: 1, accountsObserved: 1 },
    valuation: { status: liquidatable > 0 ? "UNQUALIFIED_ROUTE" : "NO_CANDIDATE", candidates: [] },
    reads: { failed: 0 },
  };
}
function mockOptions(routes, extra = {}) {
  const calls = [];
  const resolveRpc = async (chainId) => { calls.push({ kind: "resolve", chainId }); return URLS[chainId] || null; };
  const rpcCall = async (url, method, params) => {
    const chainId = chainOf(url);
    calls.push({ kind: "call", chainId, method });
    const route = routes[chainId];
    if (!route) throw new Error("NO_ROUTE");
    return route(method, params);
  };
  return { calls, options: {
    resolveRpc, rpcCall, now: () => FIXED_NOW, running: false,
    // Keep endpoint qualification offline: only the injected primary is probed.
    rpcCandidates: () => [],
    scanCrossDex: async () => crossDexArtifact(), publishCrossDex: () => {},
    scanBaseCrossDex: async () => crossDexArtifact(), publishBaseCrossDex: () => {},
    scanBalancerCrossDex: async () => crossDexArtifact(), publishBalancerCrossDex: () => {},
    scanBalancerBaseCrossDex: async () => crossDexArtifact(), publishBalancerBaseCrossDex: () => {},
    scanBalancerJoinExit: async () => joinExitArtifact(), publishBalancerJoinExit: () => {},
    scanCurveJoinExitEth: async () => curveJoinExitArtifact(), publishCurveJoinExitEth: () => {},
    scanCurveJoinExitBase: async () => curveJoinExitArtifact("NO_GROSS_EDGE", 6, ["ADD_REMOVE_USDC", "ADD_REMOVE_USDT"]), publishCurveJoinExitBase: () => {},
    scanMorphoBlueL: async () => morphoLArtifact(0), publishMorphoBlueL: () => {},
    scanMorphoBlueBaseL: async () => morphoLArtifact(0), publishMorphoBlueBaseL: () => {},
    scanAaveOf: async (chainId) => aaveOfResult(chainId), publishAaveOf: () => {},
    scanAaveL: async () => aaveLArtifact(0), publishAaveL: () => {},
    scanAaveBaseL: async () => aaveLArtifact(0), publishAaveBaseL: () => {},
    ...extra,
  } };
}
function fullRoutes(overrides = {}) {
  return {
    8453: kelpBaseRoute({ poolPaused: true }),
    42161: ostiumRoute({ maxInterval: 1000n, lastTs: 1000n, nowTs: 1500n }),
    1: ethRoute(),
    ...overrides
  };
}
function assertSanitized(artifact) {
  const serialized = JSON.stringify(artifact);
  assert.equal(/https?:\/\//i.test(serialized), false);
  assert.equal(/mock-|secret-token|rpc_endpoints|api[_-]?key|private[_-]?key|mnemonic/i.test(serialized), false);
}

test("full run yields expected statuses and a valid artifact", async () => {
  const { options, calls } = mockOptions(fullRoutes());
  const artifact = await producer.runOnce(options);
  assert.equal(producer.validateArtifact(artifact), true);
  assert.equal(artifact.schema, "profit-trigger-watch/v1");
  assert.equal(artifact.running, false);
  assert.equal(artifact.producers.length, 16);
  assert.equal(artifact.producers[0].id, "kelp-composite");
  assert.equal(artifact.producers[0].status, "BLOCKED_PAUSED");
  assert.equal(artifact.producers[0].reason, "POOL_PAUSED");
  assert.equal(artifact.producers[1].id, "ostium-settlement-window");
  assert.equal(artifact.producers[1].status, "WINDOW_CLOSED");
  assert.equal(artifact.producers[1].evidence.secondsRemaining, "500");
  assert.equal(artifact.producers[2].id, "clever-harvest");
  assert.equal(artifact.producers[2].status, "NO_CHANGE");
  assert.equal(artifact.producers[2].evidence.strategyCount, 1);
  assert.deepEqual(artifact.producers[2].evidence.strategies, [ADDR_STRATEGY]);
  assert.equal(artifact.producers[3].id, "frax-usdc-cross-venue");
  assert.equal(artifact.producers[3].status, "NO_GROSS_EDGE");
  assert.equal(artifact.producers[4].id, "base-usdc-usdt-cross-venue");
  assert.equal(artifact.producers[4].status, "NO_GROSS_EDGE");
  assert.equal(artifact.producers[4].evidence.chainId, 8453);
  assert.equal(artifact.producers[4].evidence.routeCount, 8);
  assert.equal(artifact.producers[5].id, "balancer-v2-eth-cross-venue");
  assert.equal(artifact.producers[5].status, "NO_GROSS_EDGE");
  assert.equal(artifact.producers[5].evidence.chainId, 1);
  assert.equal(artifact.producers[5].evidence.routeCount, 8);
  assert.equal(artifact.producers[6].id, "balancer-v2-base-cross-venue");
  assert.equal(artifact.producers[6].status, "NO_GROSS_EDGE");
  assert.equal(artifact.producers[6].evidence.chainId, 8453);
  assert.equal(artifact.producers[6].evidence.routeCount, 8);
  assert.equal(artifact.producers[7].id, "balancer-v2-eth-join-exit");
  assert.equal(artifact.producers[7].status, "NO_GROSS_EDGE");
  assert.equal(artifact.producers[7].evidence.chainId, 1);
  assert.equal(artifact.producers[7].evidence.routeCount, 6);
  assert.equal(artifact.producers[8].id, "curve-eth-join-exit");
  assert.equal(artifact.producers[8].status, "NO_GROSS_EDGE");
  assert.equal(artifact.producers[8].evidence.chainId, 1);
  assert.equal(artifact.producers[8].evidence.routeCount, 8);
  assert.equal(artifact.producers[9].id, "curve-base-join-exit");
  assert.equal(artifact.producers[9].status, "NO_GROSS_EDGE");
  assert.equal(artifact.producers[9].evidence.chainId, 8453);
  assert.equal(artifact.producers[9].evidence.routeCount, 6);
  assert.equal(artifact.producers[10].id, "morpho-blue-eth-l");
  assert.equal(artifact.producers[10].status, "NO_GROSS_EDGE");
  assert.equal(artifact.producers[10].evidence.chainId, 1);
  assert.equal(artifact.producers[10].evidence.routeCount, 0);
  assert.equal(artifact.producers[10].evidence.candidate, null);
  assert.equal(artifact.producers[11].id, "morpho-blue-base-l");
  assert.equal(artifact.producers[11].status, "NO_GROSS_EDGE");
  assert.equal(artifact.producers[11].evidence.chainId, 8453);
  assert.equal(artifact.producers[11].evidence.routeCount, 0);
  assert.equal(artifact.producers[11].evidence.candidate, null);
  assert.equal(artifact.producers[12].id, "aave-v3-eth-reserve-watch");
  assert.equal(artifact.producers[12].status, "NO_CHANGE");
  assert.equal(artifact.producers[12].evidence.chainId, 1);
  assert.equal(artifact.producers[12].evidence.routeCount, 5);
  assert.equal(artifact.producers[13].id, "aave-v3-base-reserve-watch");
  assert.equal(artifact.producers[13].status, "NO_CHANGE");
  assert.equal(artifact.producers[13].evidence.chainId, 8453);
  assert.equal(artifact.producers[14].id, "aave-v3-eth-l");
  assert.equal(artifact.producers[14].status, "NO_GROSS_EDGE");
  assert.equal(artifact.producers[14].evidence.chainId, 1);
  assert.equal(artifact.producers[14].evidence.routeCount, 0);
  assert.equal(artifact.producers[14].evidence.candidate, null);
  assert.equal(artifact.producers[15].id, "aave-v3-base-l");
  assert.equal(artifact.producers[15].status, "NO_GROSS_EDGE");
  assert.equal(artifact.producers[15].evidence.chainId, 8453);
  assert.equal(artifact.producers[15].evidence.routeCount, 0);
  assert.equal(artifact.producers[15].evidence.candidate, null);
  assert.deepEqual(artifact.safety, {
    localOnly: true, readOnly: true, automaticRetries: 0,
    transactionsInitiated: 0, signing: false, broadcast: false
  });
  assertSanitized(artifact);
  assert.ok(calls.filter((row) => row.kind === "call").length <= producer.MAX_NETWORK_CALLS);
  assert.equal(artifact.producers.every((row) => /^[A-Z0-9_]+$/.test(row.reason)), true);
});

test("composite kelp emits cross-chain metrics and unpause trigger", async () => {
  const routes = fullRoutes({
    8453: kelpBaseRoute({ poolPaused: false, rate: 42n, wrapperSupply: 99n }),
    42161: ostiumRoute({ maxInterval: 1000n, lastTs: 1000n, nowTs: 3000n, openPnl: -7n, price: -3n }),
    1: ethRoute({ rsethPaused: true, maxMint: 5000n, currentMinted: 7n })
  });
  const { options } = mockOptions(routes);
  const artifact = await producer.runOnce(options);
  const kelp = artifact.producers[0];
  assert.equal(kelp.status, "TRIGGER_UNPAUSE");
  assert.equal(kelp.reason, "POOL_UNPAUSED");
  assert.equal(kelp.evidence.chainId, 8453);
  assert.equal(kelp.evidence.rsethChainId, 1);
  assert.equal(kelp.evidence.poolPaused, false);
  assert.equal(kelp.evidence.getRate, "42");
  assert.equal(kelp.evidence.wrapperSupply, "99");
  assert.equal(kelp.evidence.rsethPaused, true);
  assert.equal(kelp.evidence.maxMintAmountPerDay, "5000");
  assert.equal(kelp.evidence.currentPeriodMintedAmount, "7");
  assert.equal(artifact.producers[1].status, "WINDOW_OPEN");
  assert.equal(artifact.producers[1].evidence.secondsRemaining, "0");
  assert.equal(artifact.producers[1].evidence.openPnlRaw, "-7");
  assert.equal(artifact.producers[1].evidence.lastTradePricesRaw.length, 4);
  assert.equal(artifact.producers[1].evidence.lastTradePricesRaw[0], "-3");
  assert.equal(artifact.producers[2].status, "NO_CHANGE");
  assert.equal(producer.validateArtifact(artifact), true);

  // The real mock-RPC producer output must satisfy both existing downstream
  // fired-event contracts without invoking a fork or applying any state.
  assert.equal(bridge.isFired(kelp.status), true);
  assert.equal(bridge.classifyStatus(kelp.status), "FIRED");
  assert.equal(autopilot.SUPPORTED_EVENTS.get(kelp.id), kelp.status);
  const scenarioDeps = {
    triggersDir: "offline-fixtures",
    scenarioExists: () => true,
    loadScenario: () => ({ chainId: 8453, block: "finalized" }),
  };
  const plan = bridge.buildPlan(artifact, {}, scenarioDeps);
  assert.equal(plan.rows.find((row) => row.producerId === kelp.id).status, "WOULD_FORK");
  const inspection = autopilot.inspectSource(artifact, { events: {}, routeCooldowns: {} }, FIXED_NOW,
    { planBridge: (source) => bridge.buildPlan(source, {}, scenarioDeps) });
  assert.equal(inspection.classification, "READY");
  assert.equal(inspection.selected.producerId, kelp.id);

  const legacy = structuredClone(artifact);
  legacy.producers[0].status = "UNPAUSE_TRIGGER";
  assert.equal(producer.validateArtifact(legacy), false);
  assert.equal(bridge.classifyStatus(legacy.producers[0].status), "UNKNOWN");
});

test("strategy set change flips to STRATEGY_SET_CHANGED with count", async () => {
  const routes = fullRoutes({ 1: ethRoute({ strategies: [ADDR_B, ADDR_A] }) });
  const { options } = mockOptions(routes);
  const artifact = await producer.runOnce(options);
  const clever = artifact.producers[2];
  assert.equal(clever.status, "STRATEGY_SET_CHANGED");
  assert.equal(clever.reason, "ACTIVE_STRATEGY_SET_CHANGED");
  assert.equal(clever.evidence.strategyCount, 2);
  assert.deepEqual(clever.evidence.strategies, [ADDR_B, ADDR_A]);
  assert.equal(producer.validateArtifact(artifact), true);
});

test("cross-venue producer fires only an exact economics-gated candidate", async () => {
  const { options } = mockOptions(fullRoutes(), { scanCrossDex: async () => crossDexArtifact("ATOMIC_FORK_REQUIRED") });
  const artifact = await producer.runOnce(options);
  const row = artifact.producers[3];
  assert.equal(row.status, "ATOMIC_FORK_REQUIRED");
  assert.equal(row.evidence.firedCount, 8);
  assert.match(row.evidence.candidate.eventId, /^[0-9a-f]{64}$/u);
  assert.equal(producer.validateArtifact(artifact), true);
});

test("base cross-venue producer validates chain 8453 and both directions", async () => {
  const { options } = mockOptions(fullRoutes(), { scanBaseCrossDex: async () => crossDexArtifact("ATOMIC_FORK_REQUIRED") });
  const artifact = await producer.runOnce(options);
  const row = artifact.producers[4];
  assert.equal(row.id, "base-usdc-usdt-cross-venue");
  assert.equal(row.status, "ATOMIC_FORK_REQUIRED");
  assert.equal(row.evidence.chainId, 8453);
  assert.equal(row.evidence.routeCount, 8);
  assert.equal(row.evidence.firedCount, 8);
  assert.match(row.evidence.candidate.routeKey, /^[0-9a-f]{64}$/u);
  assert.equal(producer.validateArtifact(artifact), true);

  const tampered = structuredClone(artifact);
  tampered.producers[4].evidence.chainId = 1;
  assert.equal(producer.validateArtifact(tampered), false);
  const badCandidate = structuredClone(artifact);
  badCandidate.producers[4].evidence.candidate.gasCeilingUsdcRaw =
    badCandidate.producers[4].evidence.candidate.grossDeltaRaw;
  assert.equal(producer.validateArtifact(badCandidate), false);
});

test("balancer v2 cross-venue producer validates chain 1 and fires only a gated candidate", async () => {
  const quiet = mockOptions(fullRoutes());
  const quietArtifact = await producer.runOnce(quiet.options);
  assert.equal(quietArtifact.producers[5].id, "balancer-v2-eth-cross-venue");
  assert.equal(quietArtifact.producers[5].status, "NO_GROSS_EDGE");
  assert.equal(quietArtifact.producers[5].evidence.chainId, 1);
  assert.equal(quietArtifact.producers[5].evidence.routeCount, 8);
  assert.equal(quietArtifact.producers[5].evidence.firedCount, 0);
  assert.equal(producer.validateArtifact(quietArtifact), true);

  const { options } = mockOptions(fullRoutes(), { scanBalancerCrossDex: async () => crossDexArtifact("ATOMIC_FORK_REQUIRED") });
  const artifact = await producer.runOnce(options);
  const row = artifact.producers[5];
  assert.equal(row.status, "ATOMIC_FORK_REQUIRED");
  assert.equal(row.evidence.firedCount, 8);
  assert.match(row.evidence.candidate.eventId, /^[0-9a-f]{64}$/u);
  assert.equal(producer.validateArtifact(artifact), true);

  const tampered = structuredClone(artifact);
  tampered.producers[5].evidence.chainId = 8453;
  assert.equal(producer.validateArtifact(tampered), false);
});

test("eight failed Balancer quote rows are producer failures, not schema failures", async () => {
  const { options } = mockOptions(fullRoutes(), { scanBalancerBaseCrossDex: async () => failedCrossDexArtifact() });
  const artifact = await producer.runOnce(options);
  const row = artifact.producers[6];
  assert.equal(row.status, "FAILED");
  assert.equal(row.reason, "PRODUCER_FAILED");
  assert.deepEqual(row.evidence, {});
  assert.equal(artifact.producers.some((item) => bridge.isFired(item.status)), false);
  assert.equal(producer.validateArtifact(artifact), true);
  assertSanitized(artifact);
});

test("exhausted Base Balancer reserves produce a non-firing no-edge outcome with zero unresolved failures", async () => {
  for (const mixed of [false, true]) {
    const scanned = exhaustedBalancerArtifact();
    if (mixed) {
      scanned.economics.rows[0].status = "NO_GROSS_EDGE";
      scanned.economics.rows[1].status = "GROSS_EDGE_NET_BLOCKED";
      scanned.rows[0].economics.status = "NO_GROSS_EDGE";
      scanned.rows[1].economics.status = "GROSS_EDGE_NET_BLOCKED";
    }
    scanned.rows.reverse(); // Diagnostics bind by route, never by array position.
    const { options } = mockOptions(fullRoutes(), { scanBalancerBaseCrossDex: async () => scanned });
    const artifact = await producer.runOnce(options), row = artifact.producers[6];
    assert.equal(row.status, mixed ? "GROSS_EDGE_NET_BLOCKED" : "NO_GROSS_EDGE");
    assert.equal(row.evidence.failedCount, 0);
    assert.equal(row.evidence.routeCount, 8); assert.equal(row.evidence.firedCount, 0); assert.equal(row.evidence.candidate, null);
    assert.equal(artifact.producers.some(item => bridge.isFired(item.status)), false);
    assert.equal(producer.validateArtifact(artifact), true);
    assertSanitized(artifact);
  }
});

for (const [name, mutate] of [
  ["false diagnostic", a => { a.rows[0].liquidityDiagnostic.inputExceedsRegisteredReserve = false; }],
  ["string diagnostic", a => { a.rows[0].liquidityDiagnostic.inputExceedsRegisteredReserve = "true"; }],
  ["missing diagnostic", a => { delete a.rows[0].liquidityDiagnostic; }],
  ["wrong size", a => { a.rows[0].amountInRaw = "999"; }],
  ["wrong direction", a => { a.rows[0].direction = "UNRELATED"; }],
  ["ambiguous binding", a => { a.rows.push(structuredClone(a.rows[0])); }],
  ["mismatched economics", a => { a.rows[0].economics.status = "NO_GROSS_EDGE"; }],
]) {
  test(`reserve exhaustion cannot suppress other failures: ${name}`, async () => {
    const scanned = exhaustedBalancerArtifact(); mutate(scanned);
    const { options } = mockOptions(fullRoutes(), { scanBalancerBaseCrossDex: async () => scanned });
    const artifact = await producer.runOnce(options), row = artifact.producers[6];
    assert.equal(row.status, "FAILED"); assert.equal(row.reason, "PRODUCER_FAILED");
    assert.deepEqual(row.evidence, {}); assert.equal(producer.validateArtifact(artifact), true);
  });
}

test("exhausted-reserve exception is confined to the Base Balancer producer", async () => {
  const { options } = mockOptions(fullRoutes(), {
    scanBalancerCrossDex: async () => exhaustedBalancerArtifact(), scanBaseCrossDex: async () => exhaustedBalancerArtifact(),
  });
  const artifact = await producer.runOnce(options);
  for (const index of [4, 5]) {
    assert.equal(artifact.producers[index].status, "FAILED");
    assert.equal(artifact.producers[index].reason, "PRODUCER_FAILED");
  }
  assert.equal(producer.validateArtifact(artifact), true);
});

for (const [name, mutate] of [
  ["seven rows", (artifact) => artifact.economics.rows.pop()],
  ["unknown row status", (artifact) => { artifact.economics.rows[7] = { status: "UNKNOWN" }; }],
  ["null row", (artifact) => { artifact.economics.rows[7] = null; }],
  ["missing row status", (artifact) => { artifact.economics.rows[7] = {}; }],
  ["array row", (artifact) => { artifact.economics.rows[7] = Object.assign([], { status: "FAILED" }); }],
]) {
  test(`failed Balancer rows cannot hide schema errors: ${name}`, async () => {
    const scanned = failedCrossDexArtifact();
    mutate(scanned);
    const { options } = mockOptions(fullRoutes(), { scanBalancerBaseCrossDex: async () => scanned });
    const artifact = await producer.runOnce(options);
    const row = artifact.producers[6];
    assert.equal(row.status, "FAILED");
    assert.equal(row.reason, "SCHEMA_INVALID");
    assert.deepEqual(row.evidence, {});
    assert.equal(producer.validateArtifact(artifact), true);
    assertSanitized(artifact);
  });
}

for (const mixedFailure of [false, true]) {
  test(`a fired row without its candidate remains schema-invalid (failed row: ${mixedFailure})`, async () => {
    const scanned = crossDexArtifact("ATOMIC_FORK_REQUIRED");
    scanned.forkCandidates.pop(); // The first fired row still has a candidate.
    if (mixedFailure) scanned.economics.rows[0] = failedCrossDexArtifact().economics.rows[0];
    const { options } = mockOptions(fullRoutes(), { scanBalancerBaseCrossDex: async () => scanned });
    const artifact = await producer.runOnce(options);
    const row = artifact.producers[6];
    assert.equal(row.status, "FAILED");
    assert.equal(row.reason, "SCHEMA_INVALID");
    assert.deepEqual(row.evidence, {});
    assert.equal(bridge.isFired(row.status), false);
    assert.equal(producer.validateArtifact(artifact), true);
  });
}

test("mixed failed and candidate-bound fired Balancer rows cannot promote", async () => {
  const scanned = crossDexArtifact("ATOMIC_FORK_REQUIRED");
  scanned.economics.rows[0] = failedCrossDexArtifact().economics.rows[0];
  const { options } = mockOptions(fullRoutes(), { scanBalancerBaseCrossDex: async () => scanned });
  const artifact = await producer.runOnce(options);
  const row = artifact.producers[6];
  assert.equal(row.status, "FAILED");
  assert.equal(row.reason, "PRODUCER_FAILED");
  assert.deepEqual(row.evidence, {});
  assert.equal(artifact.producers.some((item) => bridge.isFired(item.status)), false);
  assert.equal(producer.validateArtifact(artifact), true);
  assertSanitized(artifact);
});

test("complete eight-row Balancer outcomes retain their ordinary and positive classifications", async () => {
  for (const status of ["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"]) {
    const { options } = mockOptions(fullRoutes(), { scanBalancerBaseCrossDex: async () => crossDexArtifact(status) });
    const artifact = await producer.runOnce(options);
    const row = artifact.producers[6];
    assert.equal(row.status, status);
    assert.equal(row.reason, status);
    assert.equal(row.evidence.routeCount, 8);
    assert.equal(row.evidence.failedCount, 0);
    assert.equal(row.evidence.firedCount, status === "ATOMIC_FORK_REQUIRED" ? 8 : 0);
    assert.equal(row.evidence.candidate !== null, status === "ATOMIC_FORK_REQUIRED");
    assert.equal(producer.validateArtifact(artifact), true);
    assertSanitized(artifact);
  }
});

test("balancer v2 mint/redeem producer validates chain 1 and fires only a gated candidate", async () => {
  const quiet = mockOptions(fullRoutes());
  const quietArtifact = await producer.runOnce(quiet.options);
  assert.equal(quietArtifact.producers[7].id, "balancer-v2-eth-join-exit");
  assert.equal(quietArtifact.producers[7].status, "NO_GROSS_EDGE");
  assert.equal(quietArtifact.producers[7].evidence.chainId, 1);
  assert.equal(quietArtifact.producers[7].evidence.routeCount, 6);
  assert.equal(quietArtifact.producers[7].evidence.firedCount, 0);
  assert.equal(producer.validateArtifact(quietArtifact), true);

  const { options } = mockOptions(fullRoutes(), { scanBalancerJoinExit: async () => joinExitArtifact("ATOMIC_FORK_REQUIRED") });
  const artifact = await producer.runOnce(options);
  const row = artifact.producers[7];
  assert.equal(row.status, "ATOMIC_FORK_REQUIRED");
  assert.equal(row.evidence.firedCount, 6);
  assert.match(row.evidence.candidate.eventId, /^[0-9a-f]{64}$/u);
  assert.equal(row.evidence.candidate.direction, "JOIN_EXIT_USDC");
  assert.equal(producer.validateArtifact(artifact), true);

  const tampered = structuredClone(artifact);
  tampered.producers[7].evidence.chainId = 8453;
  assert.equal(producer.validateArtifact(tampered), false);
  const badDirection = structuredClone(artifact);
  badDirection.producers[7].evidence.candidate.direction = "CURVE_TO_UNIV3";
  assert.equal(producer.validateArtifact(badDirection), false);
});

test("curve mint/redeem producers validate their chain and directions", async () => {
  const { options } = mockOptions(fullRoutes(), { scanCurveJoinExitEth: async () => curveJoinExitArtifact("ATOMIC_FORK_REQUIRED") });
  const artifact = await producer.runOnce(options);
  const row = artifact.producers[8];
  assert.equal(row.id, "curve-eth-join-exit");
  assert.equal(row.status, "ATOMIC_FORK_REQUIRED");
  assert.equal(row.evidence.chainId, 1);
  assert.equal(row.evidence.routeCount, 8);
  assert.equal(row.evidence.firedCount, 8);
  assert.equal(row.evidence.candidate.direction, "ADD_REMOVE_FRAX");
  assert.match(row.evidence.candidate.eventId, /^[0-9a-f]{64}$/u);
  assert.equal(producer.validateArtifact(artifact), true);

  const badChain = structuredClone(artifact);
  badChain.producers[8].evidence.chainId = 8453;
  assert.equal(producer.validateArtifact(badChain), false);
  const badDirection = structuredClone(artifact);
  badDirection.producers[8].evidence.candidate.direction = "ADD_REMOVE_USDT";
  assert.equal(producer.validateArtifact(badDirection), false);

  const { options: baseOptions } = mockOptions(fullRoutes(), {
    scanCurveJoinExitBase: async () => curveJoinExitArtifact("ATOMIC_FORK_REQUIRED", 6, ["ADD_REMOVE_USDC", "ADD_REMOVE_USDT"]),
  });
  const baseArtifact = await producer.runOnce(baseOptions);
  const baseRow = baseArtifact.producers[9];
  assert.equal(baseRow.id, "curve-base-join-exit");
  assert.equal(baseRow.status, "ATOMIC_FORK_REQUIRED");
  assert.equal(baseRow.evidence.chainId, 8453);
  assert.equal(baseRow.evidence.routeCount, 6);
  assert.equal(baseRow.evidence.candidate.direction, "ADD_REMOVE_USDC");
  assert.equal(producer.validateArtifact(baseArtifact), true);
});

test("a failing producer does not crash the run and others still complete", async () => {
  const routes = fullRoutes({
    8453: () => { throw new Error("boom with https://leak.invalid/secret"); }
  });
  const { options } = mockOptions(routes);
  const artifact = await producer.runOnce(options);
  assert.equal(producer.validateArtifact(artifact), true);
  assert.equal(artifact.producers[0].status, "FAILED");
  assert.equal(artifact.producers[0].reason, "PRODUCER_FAILED");
  assert.deepEqual(artifact.producers[0].evidence, {});
  assert.equal(artifact.producers[1].status, "WINDOW_CLOSED");
  assert.equal(artifact.producers[2].status, "NO_CHANGE");
  assertSanitized(artifact);
});

test("missing endpoint fails closed with a sanitized reason", async () => {
  const { options } = mockOptions(fullRoutes());
  options.resolveRpc = async (chainId) => (chainId === 8453 ? null : URLS[chainId]);
  const artifact = await producer.runOnce(options);
  assert.equal(artifact.producers[0].status, "FAILED");
  assert.equal(artifact.producers[0].reason, "ENDPOINT_UNAVAILABLE");
  assert.equal(artifact.producers[1].status, "WINDOW_CLOSED");
  assertSanitized(artifact);
});

test("an ignored transport signal stops the cycle without watch publication or successors", async () => {
  let rejectOriginal;
  const original = new Promise((_, reject) => { rejectOriginal = reject; });
  let successors = 0;
  let writes = 0;
  const routes = fullRoutes({
    8453: (method) => (method === "eth_call" ? original : null)
  });
  const { options } = mockOptions(routes, {
    producerTimeoutMs: 25,
    scanCrossDex: async () => { successors += 1; return crossDexArtifact(); },
    // Even a regressed premature final publish must fail before coverage refresh
    // can reach any real scanner or filesystem.
    fsImpl: { openSync() { writes += 1; throw new Error("UNEXPECTED_PUBLISH"); } },
  });
  try {
    await assert.rejects(() => producer.runAndPublish(options), error => error.code === "DRAIN_UNCONFIRMED");
    assert.equal(successors, 0);
    assert.equal(writes, 0);
  } finally {
    rejectOriginal(new Error("LATE_MOCK_FAILURE"));
    await new Promise(resolve => setImmediate(resolve));
  }
});

test("confirmed transport drain retains TIMEOUT and serializes the next producer", async () => {
  let drained = false;
  const { options } = mockOptions(fullRoutes(), {
    producerTimeoutMs: 25,
    qualifyEndpoint: async (chainId) => {
      if (chainId !== 8453) { assert.equal(drained, true); return URLS[chainId]; }
      const signal = deadline.current().signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => {
        setImmediate(() => { drained = true; reject(new Error("MOCK_ABORT")); });
      }, { once: true }));
    },
  });
  const artifact = await producer.runOnce(options);
  assert.equal(artifact.producers[0].status, "TIMEOUT");
  assert.equal(artifact.producers[0].reason, "PRODUCER_TIMEOUT");
  assert.equal(artifact.producers[1].status, "WINDOW_CLOSED");
  assert.equal(producer.validateArtifact(artifact), true);
});

test("a late injected scanner drains before its successor and cannot publish", async () => {
  let drained = false;
  let publications = 0;
  const { options } = mockOptions(fullRoutes(), {
    producerTimeoutMs: 25,
    scanCrossDex: () => new Promise(resolve => {
      deadline.current().signal.addEventListener("abort", () => {
        setImmediate(() => { drained = true; resolve(crossDexArtifact("ATOMIC_FORK_REQUIRED")); });
      }, { once: true });
    }),
    publishCrossDex: () => { publications += 1; },
    scanBaseCrossDex: async () => { assert.equal(drained, true); return crossDexArtifact(); },
  });
  const artifact = await producer.runOnce(options);
  assert.equal(artifact.producers[3].status, "TIMEOUT");
  assert.equal(artifact.producers[3].reason, "PRODUCER_TIMEOUT");
  assert.deepEqual(artifact.producers[3].evidence, {});
  assert.equal(artifact.producers[4].status, "NO_GROSS_EDGE");
  assert.equal(publications, 0);
  assert.equal(producer.validateArtifact(artifact), true);
});

test("validateArtifact rejects tampered outputs", async () => {
  const { options } = mockOptions(fullRoutes());
  const artifact = await producer.runOnce(options);
  assert.equal(producer.validateArtifact(artifact), true);

  const badSafety = structuredClone(artifact);
  badSafety.safety.automaticRetries = 1;
  assert.equal(producer.validateArtifact(badSafety), false);

  const badStatus = structuredClone(artifact);
  badStatus.producers[0].status = "TRIGGER_UNPAUSE";
  assert.equal(producer.validateArtifact(badStatus), false);

  const badEvidence = structuredClone(artifact);
  badEvidence.producers[2].evidence.strategyCount = 7;
  assert.equal(producer.validateArtifact(badEvidence), false);

  const badStrategyStatus = structuredClone(artifact);
  badStrategyStatus.producers[2].status = "STRATEGY_SET_CHANGED";
  assert.equal(producer.validateArtifact(badStrategyStatus), false);

  const badReason = structuredClone(artifact);
  badReason.producers[1].reason = "https://leak.invalid";
  assert.equal(producer.validateArtifact(badReason), false);
});

test("decode helpers round-trip signed and unsigned values", () => {
  assert.equal(producer.decodeUint(uint(2n ** 255n)), (2n ** 255n).toString());
  assert.equal(producer.decodeInt(intHex(-123n)), "-123");
  assert.equal(producer.decodeInt(intHex(123n)), "123");
  assert.equal(producer.decodeBool(boolHex(true)), true);
  assert.equal(producer.decodeBool(boolHex(false)), false);
  assert.equal(producer.decodeAddressWord(addressWord(ADDR_A)), ADDR_A);
  assert.deepEqual(producer.decodeDynamicAddressArray(strategiesHex([ADDR_STRATEGY, ADDR_B]), 1), [ADDR_STRATEGY, ADDR_B]);
  assert.deepEqual(producer.decodeDynamicAddressArray(strategiesHex([]), 1), []);
  assert.equal(producer.encodeWord(255n), "0".repeat(62) + "ff");
  assert.throws(() => producer.decodeBool(uint(2n)), /ABI_BOOL_INVALID/);
  assert.throws(() => producer.decodeUint("0x00"), /ABI_LENGTH_INVALID/);
  assert.throws(() => producer.decodeDynamicAddressArray("0x00", 1), /ABI_LENGTH_INVALID/);
  assert.throws(() => producer.encodeAddressWord("0x1234"), /ADDRESS_INVALID/);
});

test("producer rpc qualifies past a failing primary endpoint", async () => {
  const BAD = "http://bad.invalid";
  const GOOD = "http://good.invalid";
  const seen = [];
  const rpcCall = async (url, method, params) => {
    seen.push(`${url}|${method}`);
    if (url === BAD) return null;
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return { number: "0x10", hash: `0x${"a".repeat(64)}`, timestamp: "0x1" };
    if (method === "eth_call") return `0x${"0".repeat(63)}5`;
    return null;
  };
  const rpc = producer.createChainRpc(1, {
    resolveRpc: async () => BAD, rpcCandidates: () => [GOOD], rpcCall,
  }, { calls: 0 });
  const value = await rpc.readUint("0x0000000000000000000000000000000000000001", "0x12345678");
  assert.equal(value, "5");
  assert.ok(seen.some((entry) => entry.startsWith(`${BAD}|eth_chainId`)), "primary probed");
  assert.ok(seen.some((entry) => entry.startsWith(`${GOOD}|eth_call`)), "qualified endpoint used");
});

test("producer rpc fails closed with the existing reasons when no endpoint works", async () => {
  const rpcCall = async () => null;
  const failing = producer.createChainRpc(1, {
    resolveRpc: async () => "http://bad.invalid", rpcCandidates: () => ["http://bad2.invalid"], rpcCall,
  }, { calls: 0 });
  await assert.rejects(() => failing.call("eth_getBlockByNumber", ["latest", false]), (error) => error.code === "RPC_READ_FAILED");

  const noUrl = producer.createChainRpc(1, { resolveRpc: async () => null, rpcCandidates: () => [], rpcCall }, { calls: 0 });
  await assert.rejects(() => noUrl.call("eth_getBlockByNumber", ["latest", false]), (error) => error.code === "ENDPOINT_UNAVAILABLE");

  const ledger = { calls: producer.MAX_NETWORK_CALLS };
  const capped = producer.createChainRpc(1, { resolveRpc: async () => null, rpcCandidates: () => [], rpcCall }, ledger);
  await assert.rejects(() => capped.call("eth_getBlockByNumber", ["latest", false]), (error) => error.code === "RPC_CALL_CAP");
});

test("producer artifact schema is unchanged by endpoint qualification", async () => {
  const { options } = mockOptions(fullRoutes());
  const artifact = await producer.runOnce(options);
  assert.equal(producer.validateArtifact(artifact), true);
  assert.deepEqual(Object.keys(artifact).sort(), ["generatedAt", "producers", "running", "safety", "schema"]);
  assert.equal(artifact.producers.length, producer.PRODUCER_IDS.length);
  for (const row of artifact.producers) {
    assert.deepEqual(Object.keys(row).sort(), ["evidence", "generatedAt", "id", "reason", "status"]);
  }
});

test("publishAtomic writes and reads back only the sanitized artifact", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "profit-trigger-watch-"));
  const outputPath = path.join(directory, "profit-trigger-watch.json");
  try {
    const { options } = mockOptions(fullRoutes());
    const artifact = await producer.runOnce(options);
    const published = producer.publishAtomic(artifact, { outputPath, allowedRoot: directory });
    assert.equal(published, outputPath);
    const readback = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(producer.validateArtifact(readback), true);
    assert.equal(readback.producers[0].status, "BLOCKED_PAUSED");
    assert.equal(readback.producers[2].status, "NO_CHANGE");
    assertSanitized(readback);
    assert.equal(fs.readdirSync(directory).some((name) => name.includes(".tmp-")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("balancer V3 coverage refresh hook is exported for the 240 s scheduled surface", () => {
  assert.equal(typeof producer.refreshBalancerV3CoverageBinders, "function");
});
