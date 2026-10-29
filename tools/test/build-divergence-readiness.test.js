"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildReadiness, readSource, outputPath } = require("../build-divergence-readiness.js");

const oracle = "0x" + "ab".repeat(20);
const marketId = "0x" + "cd".repeat(32);
const asset = "0x" + "11".repeat(20);
function row(overrides = {}) {
  return {
    chainId: 1, oracle, sentinel: `div:1:${oracle.slice(2, 10)}`, marketId, pair: "AAA/USDC",
    ok: true, referenceOk: true, fired: false, actionable: false,
    borrowRaw: "200", availableRaw: "300",
    measurements: { oraclePrice: "100", collateralToken: asset, loanToken: asset },
    ...overrides,
  };
}
function state(rows = [row()]) {
  return { schema: "oracle-divergence-monitor/v1", runId: "2026-09-26T04-41-56-819Z",
    generatedAt: "2026-09-26T04:41:56.819Z", sentinels: rows };
}

test("reference and positive raw liquidity are triage, not verified profit", () => {
  const out = buildReadiness(state());
  const item = out.records[0];
  assert.equal(item.sourceReportedMarketBinding, true);
  assert.equal(Object.hasOwn(item, "boundMarket"), false);
  assert.equal(Object.hasOwn(out, "sourceFreshnessAt"), false);
  assert.equal(item.liquidityObserved, true);
  assert.equal(item.triageTier, 2);
  assert.equal(out.summary.readableReferenceAndLiquidity, 1);
  assert.equal(item.routeReady, false);
  assert.equal(item.liveReady, false);
  assert.equal(item.profitRank, null);
  assert.equal(item.unverified.length, 6);
  assert.ok(Object.values(item.gates).every(g => g === "unknown"));
});

test("fired or monitor-actionable alone cannot make a route or live execution ready", () => {
  for (const fields of [{ fired: true }, { actionable: true, feedless: true, referenceOk: false }]) {
    const item = buildReadiness(state([row(fields)])).records[0];
    assert.equal(item.triageTier, 1);
    assert.equal(item.routeReady, false);
    assert.equal(item.liveReady, false);
    assert.equal(item.profitRank, null);
  }
});

test("an unreadable oracle remains an incomplete, blocked monitor row", () => {
  const item = buildReadiness(state([row({ ok: false, referenceOk: false, fired: false,
    borrowRaw: null, availableRaw: null, measurements: {} })])).records[0];
  assert.equal(item.triageTier, 3);
  assert.equal(item.sourceReportedMarketBinding, false);
  assert.equal(item.liquidityObserved, false);
  assert.equal(item.routeReady, false);
  assert.equal(item.liveReady, false);
});

test("reference and raw liquidity without source-reported market binding stay tier 4", () => {
  const absentMarket = buildReadiness(state([row({ marketId: null })])).records[0];
  const absentToken = buildReadiness(state([row({ measurements: { oraclePrice: "100", collateralToken: asset } })])).records[0];
  for (const item of [absentMarket, absentToken]) {
    assert.equal(item.monitorOk, true);
    assert.equal(item.referenceOk, true);
    assert.equal(item.liquidityObserved, true);
    assert.equal(item.sourceReportedMarketBinding, false);
    assert.equal(item.triageTier, 4);
    assert.equal(item.routeReady, false);
    assert.equal(item.liveReady, false);
  }
});

test("declared stale or future observation time never promotes execution readiness", () => {
  for (const declaredAt of ["2021-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"]) {
    const out = buildReadiness({ ...state([row({ fired: true })]), generatedAt: declaredAt });
    assert.equal(out.sourceAt, declaredAt);
    assert.equal(out.records[0].sourceAt, declaredAt);
    assert.equal(Object.hasOwn(out, "sourceFreshnessAt"), false);
    assert.equal(out.records[0].liveReady, false);
    assert.equal(out.records[0].routeReady, false);
  }
});

test("existing readiness report cannot be overwritten", () => {
  const file = path.resolve(__dirname, "..", "..", "reports", "raw", "fast", "divergence-readiness-step1", "readiness.json");
  const source = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\divergence-profit-priority-20260926\\status-divergence.json";
  const before = fs.readFileSync(file);
  const run = spawnSync(process.execPath, [path.resolve(__dirname, "..", "build-divergence-readiness.js"), "--status", source, "--out", file], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("duplicate chain/oracle, duplicate sentinel ID, malformed raw, and untrusted fields fail", () => {
  const oracle2 = "0x" + "ab".repeat(4) + "12".repeat(16);
  const row2 = row({ oracle: oracle2, sentinel: `div:1:${oracle2.slice(2, 10)}` });
  assert.throws(() => buildReadiness(state([row(), row({ oracle: oracle.toUpperCase().replace("0X", "0x"), sentinel: `div:1:${oracle.slice(2, 10).toUpperCase()}` })])), /duplicate/);
  assert.throws(() => buildReadiness(state([row(), row2])), /duplicate/);
  for (const invalid of ["-1", "1.25", "0x01", 100, "01"]) {
    assert.throws(() => buildReadiness(state([row({ borrowRaw: invalid })])), /invalid borrowRaw/);
  }
  assert.throws(() => buildReadiness(state([row({ pair: "https://untrusted.invalid/key" })])), /invalid pair/);
  assert.throws(() => buildReadiness({ ...state(), schema: "other" }), /invalid schema/);
  assert.throws(() => outputPath(path.resolve("outside.json")), /outside allowlist/);
});

test("symlink input and oversized/nonregular file are rejected before reading", () => {
  const symlinkIo = { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) };
  assert.throws(() => readSource("does-not-matter.json", symlinkIo), /symlink/);
  const oversizedIo = { existsSync: () => false, lstatSync: () => ({ isFile: () => true,
    isSymbolicLink: () => false, size: 4 * 1024 * 1024 + 1 }) };
  assert.throws(() => readSource("does-not-matter.json", oversizedIo), /bounded regular file/);
});

test("current isolated sample remains 351 blocked rows, 8 failures, 20 reference + raw liquidity", () => {
  const source = readSource("C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\divergence-profit-priority-20260926\\status-divergence.json");
  const out = buildReadiness(source);
  assert.equal(out.summary.universe, 351);
  assert.deepEqual(out.summary.byChain, { "1": 56, "999": 11, "4663": 9, "8453": 272, "42161": 3 });
  assert.equal(out.summary.monitorFailures, 8);
  assert.equal(out.summary.readableReferenceAndLiquidity, 20);
  assert.ok(out.records.every(r => !r.routeReady && !r.liveReady && r.profitRank === null));
  assert.equal(new Set(out.records.map(r => r.sentinel)).size, 351);
});
