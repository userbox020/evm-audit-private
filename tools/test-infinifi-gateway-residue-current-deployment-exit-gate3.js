#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const gate = require("./infinifi-gateway-residue-current-deployment-exit-gate3.js");

test("source fee formula floors exactly and preserves zero gate", () => {
  assert.deepEqual(gate.extraIusd(300n * 10n ** 18n, 5n * 10n ** 15n), {
    gross: "300000000000000000000", fee: "1500000000000000000", net: "298500000000000000000"
  });
  assert.deepEqual(gate.extraIusd(0n, 10n ** 16n), { gross: "0", fee: "0", net: "0" });
  assert.throws(() => gate.extraIusd(1n, gate.WAD + 1n), /INVALID_FEE/);
});

test("primary zero residue closes route before runtime, economics, and fork", () => {
  const result = gate.decideGate({ residueRaw: "0", bindingPass: false, enabledRouterCount: 9, immediateCeilingRaw: "100", marketExitAvailable: true });
  assert.deepEqual(result, { status: "CLOSED_ZERO_GATEWAY_USDC_RESIDUE", routePositive: false, executableNow: false, netPositive: false, fork: false, signing: false, economics: "NOT_RUN_PRIMARY_ZERO_GATE" });
});

test("positive residue fails closed on binding, router, and exit gates", () => {
  assert.equal(gate.decideGate({ residueRaw: "1", bindingPass: false, enabledRouterCount: 1 }).status, "WATCH_SOURCE_RUNTIME_MISMATCH");
  assert.equal(gate.decideGate({ residueRaw: "1", bindingPass: true, enabledRouterCount: 0 }).status, "WATCH_NO_CURRENTLY_ENABLED_ROUTER");
  assert.equal(gate.decideGate({ residueRaw: "1", bindingPass: true, enabledRouterCount: 1, immediateCeilingRaw: "0" }).status, "WATCH_NO_LIQUID_EXIT");
  assert.equal(gate.decideGate({ residueRaw: "1", bindingPass: true, enabledRouterCount: 1, immediateCeilingRaw: "1" }).fork, false);
});

test("sanitization rejects endpoint material recursively", () => {
  for (const value of [{ url: "redacted" }, { nested: { headers: {} } }, { note: "https://secret.invalid/key" }, { note: "wss://secret.invalid" }]) assert.throws(() => gate.assertSanitized(value));
  assert.equal(gate.assertSanitized({ anonymousFamily: "anonymous-family-01", usdcBalanceRaw: "0" }), true);
});

test("immutable normalization supports exact deployed-runtime comparison", () => {
  const compiled = "6001" + "00".repeat(20) + "6002", deployed = "6001" + "11".repeat(20) + "6002";
  assert.equal(gate.zeroRanges(compiled, { "1": [{ start: 2, length: 20 }] }), gate.zeroRanges(deployed, { "1": [{ start: 2, length: 20 }] }));
});

test("canonicalization is stable and bigint-safe", () => {
  assert.equal(gate.canonicalize({ b: 2n, a: [true, "x"] }), '{"a":[true,"x"],"b":"2"}');
});
