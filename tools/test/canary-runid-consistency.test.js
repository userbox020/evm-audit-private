"use strict";

// Offline clock-boundary regression: no RPC, API requests or global clock mutation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireCanaryOutputOwner } = require("../lib/canary-output-owner.js");
const multichain = require("../monitor-rearm-canary-multichain.js");
const divergence = require("../monitor-oracle-divergence.js");

const at = "2026-09-26T12:00:00.999Z";
const next = "2026-09-26T12:00:01.000Z";
const runId = at.replace(/[:.]/g, "-");

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-runid-offline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function crossingClock() {
  let calls = 0;
  return { now: () => (calls++ === 0 ? Date.parse(at) : Date.parse(next)), calls: () => calls };
}

function check(out, history) {
  assert.equal(out.generatedAt, at);
  assert.equal(out.runId, runId);
  assert.equal(history.generatedAt, at);
  assert.equal(history.runs.at(-1).at, at);
  assert.equal(history.runs.at(-1).runId, runId);
}

test("dedicated derives run ID and both generatedAt fields from one captured ISO time", () => {
  // The dedicated producer has no injected RPC/clock, so verify its clock construction
  // without running its live-RPC entrypoint or modifying process-global Date.
  const source = fs.readFileSync(path.join(__dirname, "../monitor-exploit-rearm-canary.js"), "utf8");
  assert.match(source, /const nowIso = new Date\(\)\.toISOString\(\);\s*const runId = nowIso\.replace\(\/\[:\.\]\/g, "-"\);/);
  assert.match(source, /generatedAt: nowIso/);
  assert.match(source, /history\.generatedAt = nowIso;/);
  assert.equal(new Date(Date.parse(at)).toISOString().replace(/[:.]/g, "-"), runId);
  assert.notEqual(new Date(Date.parse(next)).toISOString().replace(/[:.]/g, "-"), runId);
});

test("multichain publishes one coherent generation when injected clock crosses a millisecond", async (t) => {
  const dir = temporary(t);
  const output = path.join(dir, "status.json");
  const clock = crossingClock();
  const owner = acquireCanaryOutputOwner(output);
  try {
    const deps = {
      now: clock.now,
      loadStrikeSentinels: () => [],
      loadExecutions: () => null,
      qualifyChain: async () => ({ url: null, chain: { qualified: false, reason: "offline" } }),
      evaluateUpgradeConfig: async (_url, _tag, pin, spec) => ({ pin, snapshot: {},
        row: { sentinel: spec.id, chainId: spec.chainId, fired: false, ok: false, reason: "offline" } }),
    };
    const out = await multichain.runOnce(output, {}, owner, () => false, deps);
    const history = JSON.parse(fs.readFileSync(path.join(dir, "history-multichain.json"), "utf8"));
    assert.equal(clock.calls(), 1);
    check(out, history);
  } finally { owner.release(); }
});

test("divergence keeps run ID and history generation coherent across a millisecond boundary", async (t) => {
  const dir = temporary(t);
  const output = path.join(dir, "status.json");
  const clock = crossingClock();
  const owner = acquireCanaryOutputOwner(output);
  try {
    const deps = {
      now: clock.now,
      qualifyChain: async () => ({ chain: { qualified: false, reason: "offline" }, ctx: null }),
      loadConstantOracles: () => [],
    };
    const out = await divergence.runOnce(output, owner, () => false, deps);
    const history = JSON.parse(fs.readFileSync(path.join(dir, "history-divergence.json"), "utf8"));
    assert.equal(clock.calls(), 2); // The later call is for scan carry, not generation identity.
    check(out, history);
  } finally { owner.release(); }
});
