"use strict";

// Synthetic multichain pins only: no RPC, endpoint inventory, wallet or network access.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireCanaryOutputOwner, CanaryOutputOwnershipError, LOCK_NAME } =
  require("../lib/canary-output-owner.js");
const { main, runOnce, batchBlock, historicalMonitoringWindowState } = require("../monitor-rearm-canary-multichain.js");

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multichain-owner-offline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture() {
  let block = 100;
  let nowMs = Date.parse(batchBlock().startedAt) + 60_000;
  let fired = false;
  const deps = {
    now: () => nowMs,
    nextBlock() { block++; nowMs++; },
    fire() { fired = true; },
    setFire(value) { fired = value; },
    loadStrikeSentinels: () => [{ spec: "strike:1:synthetic", chainId: 1, pair: "FOO/USD" }],
    loadExecutions: () => null,
    qualifyChain: async (cid) => cid === 1
      ? { url: "fixture-only", chain: { qualified: true, block, hash: "0x" + "aa".repeat(32), timestamp: 1 } }
      : { url: null, chain: { qualified: false, reason: "endpoint-unavailable" } },
    evaluateStrikeGroup: async (_cid, specs) => specs.map((spec) => ({ sentinel: spec.spec, chainId: spec.chainId,
      fired, ok: true, reason: fired ? "synthetic-fire" : "synthetic-dormant" })),
    evaluateUpgradeConfig: async (_url, _tag, pin, spec) => ({
      pin, snapshot: { synthetic: "unchanged" },
      row: { sentinel: spec.id, chainId: spec.chainId, fired: false, ok: true, reason: "synthetic-dormant" },
    }),
  };
  return deps;
}

test("same-directory writers refuse before reads or writes; history and upgrade cursors remain intact", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const historyPath = path.join(dir, "history-multichain.json");
  const deps = fixture();
  const owner = acquireCanaryOutputOwner(out);
  try {
    await runOnce(out, {}, owner, () => false, deps);
    const status = fs.readFileSync(out, "utf8");
    const history = fs.readFileSync(historyPath, "utf8");
    let reads = 0;
    const forbidden = { now: deps.now, qualifyChain: async () => { reads++; throw Error("RPC called"); },
      runOnce: async () => { reads++; throw Error("run called"); } };
    for (const flags of [["--once", "--out", out], ["--loop", "60", "--out", out],
      ["--loop", "60", "--keep-watching-on-fire", "--no-deadline", "--out", out],
      ["--out", path.join(dir, "other.json")], ["--once", "--observation-only", "--out", out]]) {
      await assert.rejects(main(flags, forbidden), /EEXIST/);
    }
    assert.equal(reads, 0);
    assert.equal(fs.readFileSync(out, "utf8"), status);
    assert.equal(fs.readFileSync(historyPath, "utf8"), history);
    assert.equal(JSON.parse(status).upgradeState.sentinels["upgrade:1:narausd"].pin, 100);
    assert.equal(JSON.parse(history).runs[0].upgradePins["upgrade:1:narausd"], 100);
    assert.equal(fs.existsSync(path.join(dir, "other.json")), false);
    deps.nextBlock();
    await new Promise((resolve) => setTimeout(resolve, 5)); // unique millisecond run ID
    await runOnce(out, {}, owner, () => false, deps);
    const next = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    assert.deepEqual(next.runs.map((row) => row.upgradePins["upgrade:1:narausd"]), [100, 101]);
  } finally { assert.equal(owner.release(), true); }
});

test("distinct output directories work concurrently and one-shot releases lock", async (t) => {
  const dir = temporary(t);
  const a = path.join(dir, "a", "status.json");
  const b = path.join(dir, "b", "status.json");
  const owner = acquireCanaryOutputOwner(a);
  try {
    assert.equal(await main(["--once", "--out", b], fixture()), 1); // other chains unavailable
    assert.equal(fs.existsSync(path.join(dir, "b", LOCK_NAME)), false);
    assert.equal(fs.existsSync(owner.lockDir), true);
    assert.equal(JSON.parse(fs.readFileSync(b, "utf8")).batch.expiresAt, "2026-10-25T22:10:00.000Z");
  } finally { assert.equal(owner.release(), true); }
  assert.equal(await main(["--once", "--out", a], fixture()), 1);
  assert.equal(fs.existsSync(owner.lockDir), false);
});

test("default FIRE exits loop with code 3, preserves history and releases lock", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const deps = fixture();
  deps.fire();
  assert.equal(await main(["--loop", "60", "--out", out], deps), 3);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).verdict, "FIRED");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "history-multichain.json"), "utf8")).runs[0].verdict, "FIRED");
  assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
});

test("explicit unbounded read-only watch continues past expiry after FIRE and latches bounded evidence", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  let nowMs = Date.parse(batchBlock().expiresAt) + 60_000; // beyond batch metadata expiry
  let waits = 0;
  let polls = 0;
  const deps = fixture();
  deps.now = () => nowMs;
  deps.fire();
  const qualify = deps.qualifyChain;
  deps.qualifyChain = async (...args) => { if (args[0] === 1) polls++; return qualify(...args); };
  deps.sleep = async (_ms, stop) => {
    waits++;
    if (waits === 1) { deps.setFire(false); deps.nextBlock(); nowMs += 60_000; }
    else stop();
  };
  assert.equal(await main(["--loop", "60", "--keep-watching-on-fire", "--no-deadline", "--out", out], deps), 3);
  assert.equal(polls, 2);
  assert.equal(waits, 2);
  const status = JSON.parse(fs.readFileSync(out, "utf8"));
  const history = JSON.parse(fs.readFileSync(path.join(dir, "history-multichain.json"), "utf8"));
  assert.deepEqual(status.batch, batchBlock()); // historical metadata unchanged, not renewed authorization
  assert.equal(Object.hasOwn(status, "ready"), false);
  assert.equal(status.noSigning, true);
  assert.equal(status.noBroadcast, true);
  assert.equal(status.verdict, "INCOMPLETE"); // current poll, not an authorization signal
  assert.equal(status.firedCount, 0);
  assert.deepEqual(history.runs.map((row) => row.verdict), ["FIRED", "INCOMPLETE"]);
  assert.deepEqual(history.runs.map((row) => row.upgradePins["upgrade:1:narausd"]), [100, 101]);
  assert.deepEqual(status.lastFire, { runId: history.runs[0].runId, at: history.runs[0].at,
    fired: ["strike:1:synthetic"] });
  assert.deepEqual(history.lastFire, status.lastFire);
  assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
});

test("keep-watching without no-deadline retains batch expiry and explicit max-hours cap", async (t) => {
  const dir = temporary(t);
  for (const [name, startMs, hours, flags] of [
    ["batch", Date.parse(batchBlock().expiresAt) - 3600_000, 2, []],
    ["hours", Date.parse(batchBlock().startedAt) + 60_000, 2, ["--max-hours", "1"]],
  ]) {
    let nowMs = startMs;
    let polls = 0;
    const deps = fixture();
    deps.fire();
    deps.now = () => nowMs;
    const qualify = deps.qualifyChain;
    deps.qualifyChain = async (...args) => { if (args[0] === 1) polls++; return qualify(...args); };
    deps.sleep = async () => { nowMs += hours * 3600_000; };
    const out = path.join(dir, name, "status.json");
    assert.equal(await main(["--loop", "60", "--keep-watching-on-fire", ...flags, "--out", out], deps), 3);
    assert.equal(polls, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, name, "history-multichain.json"), "utf8")).runs.length, 1);
    assert.equal(fs.existsSync(path.join(dir, name, LOCK_NAME)), false);
  }
});

test("conflicting and malformed continuous flags reject before owner or chain reads", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  let called = 0;
  const deps = { now: () => Date.parse("2026-09-26T00:00:00.000Z"),
    runOnce: async () => { called++; }, qualifyChain: async () => { called++; } };
  for (const flags of [
    ["--no-deadline"], ["--loop", "60", "--no-deadline"], ["--keep-watching-on-fire"],
    ["--loop", "60", "--keep-watching-on-fire", "--no-deadline", "--max-hours", "1"],
    ["--once", "--loop", "60"], ["--loop"], ["--loop", "NaN"], ["--loop", "0"],
    ["--max-hours", "1"], ["--loop", "60", "--max-hours", "Infinity"],
    ["--loop", "60", "--loop", "60"], ["--no-deadline", "--no-deadline"], ["--unknown"],
  ]) await assert.rejects(main([...flags, "--out", out], deps));
  assert.equal(called, 0);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
});

test("lost owner during async qualification stops before status, history and cursors update", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const historyPath = path.join(dir, "history-multichain.json");
  const owner = acquireCanaryOutputOwner(out);
  const deps = fixture();
  await runOnce(out, {}, owner, () => false, deps);
  const status = fs.readFileSync(out, "utf8");
  const history = fs.readFileSync(historyPath, "utf8");
  deps.nextBlock();
  const qualify = deps.qualifyChain;
  deps.qualifyChain = async (cid, prev) => {
    const result = await qualify(cid, prev);
    if (cid === 5042) fs.writeFileSync(path.join(owner.lockDir, "owner.json"),
      JSON.stringify({ token: "replacement", pid: process.pid, startedAt: new Date().toISOString() }));
    return result;
  };
  await assert.rejects(runOnce(out, {}, owner, () => false, deps), CanaryOutputOwnershipError);
  assert.equal(fs.readFileSync(out, "utf8"), status);
  assert.equal(fs.readFileSync(historyPath, "utf8"), history);
  assert.equal(owner.release(), false);
  assert.equal(fs.existsSync(owner.lockDir), true);
});

test("lost owner after status publication stops before history cursor write", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const historyPath = path.join(dir, "history-multichain.json");
  const owner = acquireCanaryOutputOwner(out);
  const deps = fixture();
  await runOnce(out, {}, owner, () => false, deps);
  const history = fs.readFileSync(historyPath, "utf8");
  deps.nextBlock();
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, ...args) {
    const result = originalWrite.call(this, file, ...args);
    if (file === out) originalWrite.call(fs, path.join(owner.lockDir, "owner.json"),
      JSON.stringify({ token: "replacement", pid: process.pid, startedAt: new Date().toISOString() }));
    return result;
  };
  try { await assert.rejects(runOnce(out, {}, owner, () => false, deps), CanaryOutputOwnershipError); }
  finally { fs.writeFileSync = originalWrite; }
  assert.equal(fs.readFileSync(historyPath, "utf8"), history);
  assert.equal(owner.release(), false);
});

test("graceful stop during scan or loop wait publishes no post-stop artifacts and releases lock", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const owner = acquireCanaryOutputOwner(out);
  try {
    await assert.rejects(runOnce(out, {}, owner, () => true, fixture()), /multichain-scan-stopped/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(path.join(dir, "history-multichain.json")), false);
  } finally { assert.equal(owner.release(), true); }
  let polls = 0;
  const deps = fixture();
  const qualify = deps.qualifyChain;
  deps.qualifyChain = async (...args) => { if (args[0] === 1) polls++; return qualify(...args); };
  deps.sleep = async (_ms, stop) => stop();
  assert.equal(await main(["--loop", "60", "--out", out], deps), 1);
  assert.equal(polls, 1);
  assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "history-multichain.json"), "utf8")).runs.length, 1);
});

test("expiry still blocks before owner acquisition; history alias cannot be used as status", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  let called = 0;
  const deps = { now: () => Date.parse("2026-10-26T22:10:00.000Z"),
    runOnce: async () => { called++; }, qualifyChain: async () => { called++; } };
  assert.equal(batchBlock().expiresAt, "2026-10-25T22:10:00.000Z");
  for (const flags of [[], ["--once"], ["--loop", "60"], ["--loop", "60", "--keep-watching-on-fire"]]) {
    await assert.rejects(main([...flags, "--out", out], deps), /batch-expired-or-invalid/);
  }
  assert.equal(called, 0);
  assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
  await assert.rejects(main(["--out", path.join(dir, "history-multichain.json")], fixture()), CanaryOutputOwnershipError);
  assert.equal(fs.existsSync(path.join(dir, "history-multichain.json")), false);
});

test("strict observation-only runs one passive pass after expiry with unchanged historical batch and exit mapping", async (t) => {
  const dir = temporary(t);
  for (const fired of [false, true]) {
    const out = path.join(dir, String(fired), "status.json");
    const deps = fixture();
    const nowMs = Date.parse(batchBlock().expiresAt); // exact boundary is closed
    deps.now = () => nowMs;
    deps.setFire(fired);
    let passes = 0;
    const qualify = deps.qualifyChain;
    deps.qualifyChain = async (...args) => { if (args[0] === 1) passes++; return qualify(...args); };
    deps.sleep = async () => { assert.fail("observation must not wait or loop"); };
    assert.equal(await main(["--once", "--observation-only", "--out", out], deps), fired ? 3 : 1);
    assert.equal(passes, 1);
    const value = JSON.parse(fs.readFileSync(out));
    assert.equal(value.generatedAt, new Date(nowMs).toISOString());
    assert.equal(value.observationMode, "READ_ONLY_ONCE");
    assert.equal(value.historicalMonitoringWindowState, "WINDOW_CLOSED");
    assert.deepEqual(value.batch, batchBlock());
    assert.equal(value.noSigning, true);
    assert.equal(value.noBroadcast, true);
    assert.equal(Object.hasOwn(value, "ready"), false);
    assert.equal(Object.hasOwn(value, "executableNow"), false);
    assert.deepEqual(value.executedSentinels, []);
    assert.equal(fs.existsSync(path.join(path.dirname(out), LOCK_NAME)), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(out), "history-multichain.json"))).runs.length, 1);
  }
});

test("observation-only conflicts reject before owner, environment/inventory overrides or any scan", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const forbidden = { now: () => { assert.fail("clock must not be reached"); }, runOnce: async () => assert.fail("scan") };
  for (const args of [["--observation-only"], ["--once", "--observation-only", "--observation-only"],
    ...[["--loop", "60"], ["--max-hours", "1"], ["--no-deadline"], ["--keep-watching-on-fire"],
      ["--supervised-readonly"], ["--rh-user-gateway-env"], ["--rh-archive-inventory", "robinhood_archive_endpoints.md"],
      ["--execute"], ["--keep-watching"]].map((flags) => ["--once", "--observation-only", ...flags])]) {
    await assert.rejects(main([...args, "--out", out], forbidden));
  }
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
});

test("historical window states fail closed for malformed dates and use exclusive end boundary", () => {
  const window = batchBlock(), start = Date.parse(window.startedAt), end = Date.parse(window.expiresAt);
  for (const [now, expected] of [[start - 1, "NOT_STARTED"], [start, "OPEN"], [end - 1, "OPEN"],
    [end, "WINDOW_CLOSED"], [end + 1, "WINDOW_CLOSED"], [NaN, "INVALID"]]) {
    assert.equal(historicalMonitoringWindowState(window, now), expected);
  }
  for (const invalid of [null, {}, { ...window, startedAt: null }, { ...window, expiresAt: "" },
    { ...window, expiresAt: "2026-02-30T22:10:00.000Z" }, { ...window, expiresAt: window.startedAt },
    { ...window, expiresAt: "bad" }, { ...window, startedAt: window.expiresAt, expiresAt: window.startedAt }]) {
    assert.equal(historicalMonitoringWindowState(invalid, start), "INVALID");
  }
});
