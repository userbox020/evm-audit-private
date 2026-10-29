"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { compileFunction } = require("node:vm");

// Reuse the owned synthetic transport, without registering or running its suite.
const fixtureFile = require.resolve("./watch-top-whale-triggers.test.js");
const fixtureRequire = createRequire(fixtureFile);
const inertRequire = Object.assign(name => name === "node:test" ? () => {} : fixtureRequire(name), { resolve: fixtureRequire.resolve });
const fixtureModule = { exports: {} };
compileFunction(fs.readFileSync(fixtureFile, "utf8") +
  "\nmodule.exports = { captureFixture, defaultTransportCollector, ETH_HEADER, BASE_HEADER };",
["require", "module"], { filename: fixtureFile })(inertRequire, fixtureModule);
const { captureFixture, defaultTransportCollector, ETH_HEADER, BASE_HEADER } = fixtureModule.exports;
const W = 10n ** 18n;
const SOURCE = "tools/watch-top-whale-triggers.js";
const KEY = "targetA6_AaveV4_syrupUSDG_USDG_0xbd81";
const now = Number(BigInt(ETH_HEADER.timestamp)) * 1000 + 60000;

function assertReadOnly(row) {
  assert.equal(row.observationKind, "READ_ONLY_MONITOR");
  assert.equal(row.observationSource, SOURCE);
  assert.equal(row.armed, false);
  assert.equal(row.executableNow, false);
  assert.doesNotMatch(row.readinessNote || "", /\barmed\b|ready for immediate/i);
}

test("non-M32 underwater observations preserve route eligibility, gains and calldata without LIVE authority", async () => {
  const { state } = await captureFixture({ includeA6A7: true, syrupHealthFactors: { "#A6": W / 2n, "#A7": W / 2n } });
  assertReadOnly(state);
  for (const value of Object.values(state.targets)) for (const row of Array.isArray(value) ? value : [value]) assertReadOnly(row);
  const row = Object.values(state.targets).find(row => row.rank === "#A6");
  assert.equal(row.liquidatableNow, true);
  assert.equal(row.eligibleForPreflight, true);
  assert.ok(row.readyExecuteUniV4FlashCalldata.startsWith("0x"));
  assert.ok(row.liveQuote.grossSurplusUsdc > 0);
  assert.equal(row.quoteKind, "HISTORICAL_REFERENCE");
  assert.equal(row.liveQuote.provenance, "HISTORICAL_REFERENCE");
  assert.equal(row.liveQuote.observationBlock, null);
  assert.equal(row.liveQuote.observationHash, null);
  assert.equal(row.liveQuote.observationUtc, null);
  assert.equal(row.quoteCurrent, false);
  assert.equal(row.quoteObservation, null);
  assert.deepEqual(state.safety, { readOnly: true, rpcUrlsStored: false, signedActions: false });
});

test("pinned measured quotes and model fallback estimates are distinct", async () => {
  const fresh = (await captureFixture()).state;
  const row = fresh.targets.targetM2_Morpho_reUSD_USDC;
  assert.equal(row.quoteKind, "ONCHAIN_MEASURED");
  assert.equal(row.liveQuote.provenance, "ONCHAIN_MEASURED");
  assert.equal(row.liveQuote.observationBlock, fresh.pin.number);
  assert.equal(row.liveQuote.observationHash, fresh.pin.hash);
  assert.equal(row.liveQuote.observationUtc, fresh.pin.utc);
  assert.equal(row.quoteCurrent, true);
  assert.deepEqual(row.quoteObservation, fresh.pin);
  const failed = (await captureFixture({ m2QuoteFailed: true })).state.targets.targetM2_Morpho_reUSD_USDC;
  assert.equal(failed.quoteKind, "MODEL_ESTIMATE");
  assert.equal(failed.liveQuote.provenance, "MODEL_ESTIMATE");
  assert.equal(failed.liveQuote.observationHash, null);
  assert.equal(failed.quoteCurrent, false);
  assert.equal(failed.quoteObservation, null);
  const base = (await captureFixture({ armedBase: true, baseRates: [0n, 0n] })).state;
  const model = base.targets.extra_Base_USDe_Whales.find(row => row.rank === "#B7");
  assert.equal(model.quoteKind, "MODEL_ESTIMATE");
  assert.equal(model.liveQuote.provenance, "MODEL_ESTIMATE");
  assert.equal(model.quoteCurrent, false);
  assert.ok(model.liveQuote);
});

test("failed extended refresh and a later parent never renew the row or quote pin", async () => {
  let delegate, collect;
  const collectorFactory = transport => {
    delegate = transport;
    collect ||= defaultTransportCollector((...args) => delegate(...args), now);
    return collect;
  };
  const options = { armedBase: true, baseRates: [0n, 0n], collectorFactory, includeA6A7: true };
  const first = (await captureFixture(options)).state;
  const key = Object.keys(first.targets).find(key => first.targets[key].rank === "#A6");
  const saved = { ...ETH_HEADER };
  try {
    ETH_HEADER.number = `0x${(BigInt(ETH_HEADER.number) + 1n).toString(16)}`;
    ETH_HEADER.hash = `0x${"88".repeat(32)}`;
    ETH_HEADER.timestamp = `0x${(BigInt(ETH_HEADER.timestamp) + 12n).toString(16)}`;
    const next = (await captureFixture({ ...options, syrupFailures: { "#A6": "transport" } })).state;
    const row = next.targets[key];
    assert.notEqual(next.pin.hash, first.pin.hash);
    assert.equal(row.observationHash, first.pin.hash);
    assert.equal(row.observationTimestamp, first.pin.timestamp);
    assert.equal(row.observationStatus, "INCOMPLETE");
    assert.equal(row.refreshStatus, "INCOMPLETE");
    assert.equal(row.refreshReason, "TARGET_REFRESH_FAILED");
    assert.equal(row.eligibleForPreflight, false);
    assert.equal(row.quoteCurrent, false);
    assert.deepEqual(row.liveQuote, first.targets[key].liveQuote);
    assert.equal(row.readyExecuteUniV4FlashCalldata, first.targets[key].readyExecuteUniV4FlashCalldata);
    assert.equal(row.nextBlockForecast, undefined);
    assertReadOnly(row);
  } finally { Object.assign(ETH_HEADER, saved); }
});

test("restart retention uses only original row age, never generatedAt or now", async () => {
  const fresh = (await captureFixture({ includeA6A7: true })).state;
  const key = Object.keys(fresh.targets).find(key => fresh.targets[key].rank === "#A6");
  for (const age of [60000, 900001, null]) {
    const row = { ...fresh.targets[key] };
    if (age === null) for (const field of ["observationBlock", "observationHash", "observationTimestamp", "observationUtc"]) delete row[field];
    else row.observationTimestamp = (now - age) / 1000;
    // Use integral seconds for the expired case.
    if (age !== null) row.observationTimestamp = Math.floor(row.observationTimestamp);
    const previous = { ...fresh, generatedAt: new Date(now).toISOString(), targets: { [key]: row } };
    const collectorFactory = transport => defaultTransportCollector(transport, now, previous);
    const state = (await captureFixture({ armedBase: true, baseRates: [0n, 0n], includeA6A7: true,
      syrupFailures: { "#A6": "transport" }, collectorFactory })).state;
    const restored = state.targets[key];
    if (age > 900000) { assert.equal(restored, undefined); continue; }
    assert.equal(restored.observationTimestamp, row.observationTimestamp ?? null);
    assert.equal(restored.observationHash, row.observationHash ?? null);
    assert.equal(restored.refreshStatus, "INCOMPLETE");
    assert.equal(restored.quoteCurrent, false);
    assert.equal(restored.eligibleForPreflight, false);
  }
});

test("Base cached measurements preserve their own pin and are incomplete after refresh failure", async () => {
  const first = (await captureFixture({ armedBase: true, baseRates: [0n, 0n] })).state;
  const original = first.targets.targetB0_Base_USDe_USDC;
  const previous = { ...first, targets: { ...first.targets,
    extra_Base_USDe_Whales: Array.from({ length: 7 }, () => ({ ...original })) } };
  const baseNow = Number(BigInt(BASE_HEADER.timestamp)) * 1000 + 60000;
  const collectorFactory = transport => defaultTransportCollector(transport, baseNow, previous);
  const next = (await captureFixture({ armedBase: true, missingRpc: true, collectorFactory })).state;
  const row = next.targets.targetB0_Base_USDe_USDC;
  assert.equal(next.baseObservation.status, "INCOMPLETE");
  assert.deepEqual(next.baseObservation.pin, first.baseObservation.pin);
  assert.equal(row.observationHash, original.observationHash);
  assert.equal(row.observationTimestamp, original.observationTimestamp);
  assert.deepEqual(row.quoteObservation, original.quoteObservation);
  assert.equal(row.liveQuote.observationBlock, original.liveQuote.observationBlock);
  assert.equal(row.liveQuote.observationHash, original.liveQuote.observationHash);
  assert.equal(row.liveQuote.observationUtc, original.liveQuote.observationUtc);
  assert.equal(row.quoteKind, "ONCHAIN_MEASURED");
  assert.equal(row.quoteCurrent, false);
  assert.equal(row.refreshReason, "BASE_REFRESH_FAILED");
  assertReadOnly(row);
});

test("unknown-age Base restart rows cannot inherit the new Ethereum parent or a quote pin", async () => {
  const row = { rank: "#B0", liquidatableNow: true, armed: true, executableNow: true,
    quoteKind: "ONCHAIN_MEASURED", liveQuote: { grossSurplusUsdc: 5 } };
  const previous = { generatedAt: new Date(now).toISOString(), baseObservation: { status: "COMPLETE" }, targets: {
    targetB0_Base_USDe_USDC: row, base_Morpho_Whales: [], extra_Base_USDe_Whales: Array.from({ length: 7 }, () => row),
  } };
  const collectorFactory = transport => defaultTransportCollector(transport, now, previous);
  const { state } = await captureFixture({ armedBase: true, missingRpc: true, collectorFactory });
  const restored = state.targets.targetB0_Base_USDe_USDC;
  assert.equal(restored.observationTimestamp, null);
  assert.equal(restored.observationHash, null);
  assert.equal(restored.quoteObservation, null);
  assert.equal(restored.liveQuote.provenance, null);
  assert.equal(restored.quoteKind, null);
  assert.equal(restored.quoteCurrent, false);
  assert.equal(restored.refreshStatus, "INCOMPLETE");
  assert.equal(restored.eligibleForPreflight, false);
});

test("legacy quotes with a known row pin and sibling kind still have unknown quote provenance", async () => {
  const original = (await captureFixture({ includeA6A7: true })).state;
  const key = Object.keys(original.targets).find(key => original.targets[key].rank === "#A6");
  const cached = { ...original.targets[key], quoteKind: "ONCHAIN_MEASURED", quoteObservation: original.pin,
    liveQuote: { grossSurplusUsdc: 123.45 } };
  const previous = { ...original, targets: { [key]: cached } };
  const collectorFactory = transport => defaultTransportCollector(transport, now, previous);
  const { state } = await captureFixture({ armedBase: true, baseRates: [0n, 0n], includeA6A7: true,
    syrupFailures: { "#A6": "transport" }, collectorFactory });
  const row = state.targets[key];
  assert.equal(row.liveQuote.grossSurplusUsdc, 123.45);
  assert.equal(row.liveQuote.provenance, null);
  assert.equal(row.liveQuote.observationBlock, null);
  assert.equal(row.liveQuote.observationHash, null);
  assert.equal(row.liveQuote.observationUtc, null);
  assert.equal(row.quoteKind, null);
  assert.equal(row.quoteObservation, null);
  assert.equal(row.quoteCurrent, false);
  assert.equal(row.observationHash, original.pin.hash);
  assert.equal(row.observationStatus, "INCOMPLETE");
});

test("import performs no IO; failed watch emits only bounded sanitized incomplete evidence", async () => {
  const file = require.resolve("../watch-top-whale-triggers.js"), localRequire = createRequire(file);
  const source = fs.readFileSync(file, "utf8").replace(/^#![^\n]*\n/, "");
  const old = { generatedAt: "2026-01-01T00:00:00.000Z", pin: { hash: `0x${"44".repeat(32)}` },
    targets: { [KEY]: { liquidatableNow: true, armed: true, executableNow: true, liveQuote: { grossSurplusUsd: 5 } } } };
  const writes = [], logs = [], events = [];
  const io = name => { events.push(name); };
  const denied = () => { io("rpc"); throw new Error("PRIVATE_PROVIDER_ERROR_DO_NOT_PERSIST"); };
  const fixtureFs = { readFileSync: () => { io("read"); return JSON.stringify(old); },
    mkdirSync: () => io("mkdir"), writeFileSync: (_path, text) => { io("write"); writes.push(JSON.parse(text)); },
    renameSync: () => io("rename"), unlinkSync: () => io("unlink") };
  const module = { exports: {} };
  compileFunction(source, ["exports", "require", "module", "__filename", "__dirname", "fetch", "console"], { filename: file })(
    module.exports, name => name === "node:fs" ? fixtureFs : name === "./shared-rpc.js"
      ? { rpcCall: denied, resolveRpc: denied } : localRequire(name), module, file, path.dirname(file), denied,
    { log: text => logs.push(text), error: text => logs.push(text) });
  assert.deepEqual(events, []);
  await assert.rejects(module.exports.main(["--once"]), /^Error: WATCH_ITERATION_FAILED$/);
  assert.equal(writes.length, 1);
  const failed = writes[0];
  assert.equal(failed.generatedAt, old.generatedAt);
  assert.deepEqual(failed.pin, old.pin);
  assert.equal(failed.refreshStatus, "INCOMPLETE");
  assert.equal(failed.refreshReason, "WATCH_ITERATION_FAILED");
  assert.deepEqual(failed.firedTriggers, []);
  assert.equal(failed.targets[KEY].observationTimestamp, null);
  assert.equal(failed.targets[KEY].quoteCurrent, false);
  assert.equal(failed.targets[KEY].liveQuote.provenance, null);
  assert.equal(failed.targets[KEY].eligibleForPreflight, false);
  assert.equal(failed.targets[KEY].liquidatableNow, true);
  assertReadOnly(failed.targets[KEY]);
  assert.doesNotMatch(JSON.stringify({ writes, logs }), /PRIVATE_PROVIDER_ERROR/);
});
