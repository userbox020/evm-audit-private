"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { projectCanaryArmReadiness: project } = require("../lib/canary-arm-readiness.js");

const NOW = Date.parse("2026-09-26T12:00:00Z");
const identity = { chainId: 1, marketId: "0x" + "11".repeat(32), actionId: "borrow-and-exit" };
const batchCommitment = "0x" + "22".repeat(32);
const scopeCommitment = "0x" + "33".repeat(32);
const pin = (block, timeMs = NOW, hash = "0x" + block.toString(16).padStart(64, "0")) =>
  ({ chainId: 1, block, hash, timeMs, witnessed: true });
const signal = (status, block, timeMs) => ({ status, condition: status === "FIRED", identity,
  batchCommitment, scopeCommitment, pin: pin(block, timeMs) });
const inputs = () => ({
  nowMs: NOW,
  plan: { immutable: true, independent: true, sameMarket: true, forkRehearsed: true,
    realFundingProved: true, conditionalNetPositive: true, nonSynthetic: true, identity },
  authority: { state: "VALID", signatureVerified: true, mode: "PRODUCTION",
    batchCommitment, scopeCommitment, actionMatch: true, capsOk: true,
    notBeforeMs: NOW - 100_000, expiresAtMs: NOW + 100_000, identity },
  producer: { active: true, sole: true, leaseValid: true, continuityAttested: true,
    leaseExpiresAtMs: NOW + 100_000 },
  signal: signal("DORMANT", 100, NOW - 3000),
});
const recheck = () => ({ identity, batchCommitment, scopeCommitment,
  pin: pin(103, NOW + 1000), borrowExecutable: true, exitExecutable: true,
  gasBounded: true, slippageBounded: true, nonSynthetic: true, conservativeNet: "1" });
const safe = (output) => {
  assert.equal(output.monitoringOnly, true);
  assert.equal(output.noSigning, true);
  assert.equal(output.noBroadcast, true);
  assert.equal(output.dispatchAllowed, false);
  assert.equal(output.evidenceStatus, "CALLER_ATTESTED_ONLY");
  assert.equal(output.requiresVerifiedController, true);
};

test("ABSENT DORMANT remains NOT_READY and projection never dispatches", () => {
  const input = inputs();
  input.authority = { state: "ABSENT" };
  const output = project(input);
  assert.equal(output.state, "NOT_READY");
  safe(output);
});

test("VALID DORMANT stays ARMED_WAITING over advancing polls despite false condition", () => {
  const input = inputs();
  input.signal.condition = false;
  const first = project(input);
  assert.equal(first.state, "ARMED_WAITING");
  safe(first);
  input.nowMs += 2000;
  input.previous = first;
  input.signal.pin = pin(101, NOW - 1000);
  const second = project(input);
  assert.equal(second.state, "ARMED_WAITING");
  assert.deepEqual(second.pin, input.signal.pin);
  safe(second);
});

test("condition contradiction, wrong action/scope and unwitnessed signal fail closed", () => {
  for (const mutate of [
    (i) => { i.signal.condition = true; },
    (i) => { i.signal.condition = undefined; },
    (i) => { i.signal.identity = { ...identity, actionId: "other-action" }; },
    (i) => { i.signal.scopeCommitment = "0x" + "44".repeat(32); },
    (i) => { i.signal.batchCommitment = "0x" + "44".repeat(32); },
    (i) => { i.signal.pin.witnessed = false; },
  ]) {
    const input = inputs();
    mutate(input);
    const output = project(input);
    assert.equal(output.state, "NOT_READY");
    safe(output);
  }
  const fired = inputs();
  fired.previous = project(fired);
  fired.nowMs += 2000;
  fired.signal = signal("FIRED", 102, NOW);
  fired.signal.condition = false;
  fired.recheck = recheck();
  const output = project(fired);
  assert.equal(output.state, "BLOCKED_RECHECK");
  safe(output);
});

test("more than two minutes without a preceding poll fails closed for dormant and fired", () => {
  const input = inputs();
  input.previous = project(input);
  input.nowMs = NOW + 120_001;
  input.authority.expiresAtMs = input.nowMs + 100_000;
  input.producer.leaseExpiresAtMs = input.nowMs + 100_000;
  input.signal = signal("DORMANT", 101, input.nowMs - 1000);
  const dormant = project(input);
  assert.equal(dormant.state, "NOT_READY");
  safe(dormant);
  input.signal = signal("FIRED", 101, input.nowMs - 1000);
  input.recheck = { ...recheck(), pin: pin(102, input.nowMs) };
  const fired = project(input);
  assert.equal(fired.state, "BLOCKED_RECHECK");
  safe(fired);
});

test("missing independent route, real funding or non-synthetic proof cannot arm", () => {
  for (const proof of ["independent", "sameMarket", "forkRehearsed", "realFundingProved", "conditionalNetPositive", "nonSynthetic"]) {
    const input = inputs();
    input.plan[proof] = false;
    const output = project(input);
    assert.equal(output.state, "NOT_READY", proof);
    safe(output);
  }
});

test("exact action/scope, signature, mode and sole active lease are required", () => {
  for (const change of [
    (i) => { i.authority.identity = { ...identity, actionId: "another-action" }; },
    (i) => { i.authority.actionMatch = false; },
    (i) => { i.authority.capsOk = false; },
    (i) => { i.authority.signatureVerified = false; },
    (i) => { i.authority.mode = "SIMULATION"; },
    (i) => { i.authority.scopeCommitment = "garbage"; },
    (i) => { i.producer.sole = false; },
    (i) => { i.producer.continuityAttested = false; },
    (i) => { i.producer.leaseExpiresAtMs = NOW; },
  ]) {
    const input = inputs();
    change(input);
    const output = project(input);
    assert.equal(output.state, "NOT_READY");
    safe(output);
  }
});

test("explicit revocation and expiry, including elapsed VALID batch, are terminal", () => {
  for (const [state, expected] of [["EXPIRED", "EXPIRED"], ["REVOKED", "REVOKED"]]) {
    const input = inputs();
    input.authority.state = state;
    const output = project(input);
    assert.equal(output.state, expected);
    safe(output);
  }
  const input = inputs();
  input.nowMs = input.authority.expiresAtMs;
  assert.equal(project(input).state, "EXPIRED");
});

test("supplied same-batch terminal previous states cannot rearm on a later dormant poll", () => {
  for (const terminal of ["EXPIRED", "REVOKED", "BLOCKED_RECHECK", "TRIGGERED"]) {
    const input = inputs();
    const first = project(input);
    input.previous = { ...first, state: terminal };
    input.nowMs += 2000;
    input.signal.pin = pin(101, NOW);
    const output = project(input);
    assert.equal(output.state, terminal === "EXPIRED" || terminal === "REVOKED" ? terminal : "BLOCKED_RECHECK");
    safe(output);
  }
  const input = inputs();
  input.authority.state = "REVOKED";
  const revoked = project(input);
  input.authority.state = "VALID";
  input.previous = revoked;
  assert.equal(project(input).state, "REVOKED");
});

test("FIRED missing, stale, reorged and negative-net rechecks block, never auto-rearm", () => {
  for (const mutate of [
    (i) => { i.recheck = undefined; },
    (i) => { i.recheck.pin = pin(101, NOW - 1000); },
    (i) => { i.recheck.pin.witnessed = false; },
    (i) => { i.recheck.pin = pin(102, NOW - 2000); },
    (i) => { i.recheck.pin = pin(103, NOW + 3000); },
    (i) => { i.recheck.pin = pin(103, NOW - 10 * 60 * 1000 - 1); },
    (i) => { i.recheck.conservativeNet = "-1"; },
    (i) => { i.recheck.conservativeNet = "01"; },
    (i) => { i.recheck.nonSynthetic = false; },
    (i) => { i.recheck.gasBounded = false; },
    (i) => { i.recheck.slippageBounded = false; },
    (i) => { i.recheck.borrowExecutable = false; },
    (i) => { i.recheck.exitExecutable = false; },
    (i) => { i.recheck.scopeCommitment = "0x" + "44".repeat(32); },
    (i) => { i.recheck.identity = { ...identity, marketId: "0x" + "44".repeat(32) }; },
  ]) {
    const input = inputs();
    input.previous = project(input);
    input.nowMs = NOW + 2000;
    input.signal = signal("FIRED", 102, NOW);
    input.recheck = recheck();
    mutate(input);
    const blocked = project(input);
    assert.equal(blocked.state, "BLOCKED_RECHECK");
    safe(blocked);
    input.previous = blocked;
    input.nowMs += 1000;
    input.signal = signal("DORMANT", 104, NOW + 2000);
    assert.equal(project(input).state, "BLOCKED_RECHECK");
  }
});

test("fresh witnessed profitable recheck on FIRED is a decision, not execution", () => {
  const input = inputs();
  input.previous = project(input);
  input.nowMs = NOW + 2000;
  input.signal = signal("FIRED", 102, NOW);
  input.recheck = { ...recheck(), conservativeNet: 1n };
  const output = project(input);
  assert.equal(output.state, "TRIGGERED");
  assert.deepEqual(output.recheckPin, input.recheck.pin);
  safe(output);
});

test("duplicate, regressing clock/block, stale/future pin and initial FIRED fail closed", () => {
  const input = inputs();
  const first = project(input);
  input.previous = first;
  assert.equal(project(input).state, "NOT_READY");
  input.nowMs = NOW - 1;
  input.signal.pin = pin(101, NOW - 2000);
  assert.equal(project(input).state, "NOT_READY");
  input.nowMs = NOW + 2000;
  input.signal.pin = pin(99, NOW);
  assert.equal(project(input).state, "NOT_READY");
  input.signal.pin = pin(100, NOW, "0x" + "ff".repeat(32));
  assert.equal(project(input).state, "NOT_READY");
  input.signal.pin = pin(101, NOW + 3000);
  assert.equal(project(input).state, "NOT_READY");
  input.signal.pin = pin(101, NOW - 10 * 60 * 1000 - 1);
  assert.equal(project(input).state, "NOT_READY");
  const fresh = inputs();
  fresh.signal = signal("FIRED", 100, NOW - 3000);
  fresh.recheck = recheck();
  assert.equal(project(fresh).state, "BLOCKED_RECHECK");
  fresh.previous = first;
  fresh.nowMs = NOW + 2000;
  fresh.signal.pin = pin(100, NOW);
  assert.equal(project(fresh).state, "BLOCKED_RECHECK");
});
