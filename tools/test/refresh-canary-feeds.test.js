"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { FEEDS, SOURCE_DIR, STATUS_FILE, CHILD_TIMEOUT_MS, runChild, runOnce, main } = require("../refresh-canary-feeds");
const { acquireCanaryOutputOwner, LOCK_NAME } = require("../lib/canary-output-owner");
const { batchBlock, historicalMonitoringWindowState } = require("../monitor-rearm-canary-multichain");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canary-feeds-offline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, SOURCE_DIR), { recursive: true });
  let clock = Date.parse(batchBlock().startedAt) + 60_000;
  return { root, now: () => clock, advance: (ms = 1) => { clock += ms; } };
}

function publish(f, feed, exitCode = 0, overrides = {}) {
  const file = path.join(f.root, SOURCE_DIR, feed.file);
  // Exercise the actual shared directory lock, not a stand-in mutex.
  const owner = acquireCanaryOutputOwner(file);
  try {
    fs.writeFileSync(file, JSON.stringify({ schema: feed.schema,
      generatedAt: new Date(f.now()).toISOString(), noSigning: true, noBroadcast: true,
      ...(feed.id === "multichain" ? { batch: batchBlock(), observationMode: "READ_ONLY_ONCE",
        historicalMonitoringWindowState: historicalMonitoringWindowState(batchBlock(), f.now()) } : {}),
      verdict: { 0: "DORMANT", 1: "INCOMPLETE", 3: "FIRED" }[exitCode],
      sentinels: [{ ok: exitCode !== 1, fired: exitCode === 3 }], ...overrides }));
  } finally { assert.equal(owner.release(), true); }
}

test("sequential producers release their shared lock; incomplete and FIRE observations both advance", async (t) => {
  const f = fixture(t);
  const visited = [];
  const codes = [0, 1, 3];
  const result = await runOnce({ ...f, launch: async (script) => {
    const index = visited.length;
    visited.push(script);
    await new Promise((resolve) => setImmediate(resolve));
    f.advance();
    publish(f, FEEDS[index], codes[index]);
    return { exitCode: codes[index] };
  } });
  assert.deepEqual(visited, FEEDS.map((feed) => feed.script));
  assert.equal(result.updatedCount, 3);
  assert.equal(result.status, "DEGRADED");
  assert.deepEqual(result.feeds.map((row) => row.verdict), ["DORMANT", "INCOMPLETE", "FIRED"]);
  assert.equal(fs.existsSync(path.join(f.root, SOURCE_DIR, LOCK_NAME)), false);
  assert.equal(fs.existsSync(path.join(path.dirname(path.join(f.root, STATUS_FILE)), LOCK_NAME)), false);
});

test("concurrent refresh cannot overwrite a running pass or spawn a second child", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const result = await runOnce({ ...f, launch: async (script) => {
    calls++;
    const before = fs.readFileSync(path.join(f.root, STATUS_FILE), "utf8");
    await assert.rejects(runOnce({ ...f, launch: () => { throw new Error("must not launch"); } }), /EEXIST/);
    assert.equal(fs.readFileSync(path.join(f.root, STATUS_FILE), "utf8"), before);
    publish(f, FEEDS.find((feed) => feed.script === script));
    return { exitCode: 0 };
  } });
  assert.equal(calls, 3);
  assert.equal(result.status, "UPDATED");
});

test("old, future, malformed, and wrong-verdict artifacts never count as a refresh", async (t) => {
  for (const overrides of [
    { generatedAt: "2020-01-01T00:00:00.000Z" },
    { generatedAt: "2100-01-01T00:00:00.000Z" },
    { schema: "unexpected/v1" },
    { noBroadcast: false },
    { verdict: "FIRED" },
  ]) {
    const f = fixture(t);
    const result = await runOnce({ ...f, launch: async (script) => {
      publish(f, FEEDS.find((feed) => feed.script === script), 0, overrides);
      return { exitCode: 0 };
    } });
    assert.equal(result.status, "FAILED");
    assert.equal(result.updatedCount, 0);
    assert.ok(result.feeds.every((row) => row.reason === "OBSERVATION_NOT_UPDATED_OR_INVALID"));
  }
});

test("existing or abandoned producer ownership blocks subsequent work without taking over", async (t) => {
  for (const beforeLaunch of [true, false]) {
    const f = fixture(t);
    const lock = path.join(f.root, SOURCE_DIR, LOCK_NAME);
    if (beforeLaunch) fs.mkdirSync(lock);
    let calls = 0;
    const result = await runOnce({ ...f, launch: async () => {
      calls++;
      fs.mkdirSync(lock);
      return { exitCode: null, timedOut: true };
    } });
    assert.equal(calls, beforeLaunch ? 0 : 1);
    assert.equal(result.status, "BLOCKED");
    assert.equal(fs.existsSync(lock), true);
    assert.equal(result.updatedCount, 0);
  }
});

test("historical expiry never blocks independent one-shot observations or renews the window", async (t) => {
  for (const initiallyExpired of [true, false]) {
    const f = fixture(t);
    const expire = () => f.advance(Date.parse(batchBlock().expiresAt) - f.now());
    if (initiallyExpired) expire();
    let calls = 0;
    const result = await runOnce({ ...f, launch: async (script, root, timeout, args) => {
      calls++;
      assert.equal(root, f.root);
      assert.equal(timeout, 5 * 60_000);
      assert.deepEqual(args, script === FEEDS[1].script ? ["--once", "--observation-only"] : ["--once"]);
      publish(f, FEEDS.find((feed) => feed.script === script));
      expire();
      return { exitCode: 0 };
    } });
    assert.equal(calls, 3);
    assert.equal(result.reason, null);
    assert.equal(result.status, "UPDATED");
    assert.equal(result.monitoringEndsAt, "2026-10-25T22:10:00.000Z");
    assert.equal(result.observationMode, "READ_ONLY_ONCE");
    assert.equal(result.historicalMonitoringWindowState, "WINDOW_CLOSED");
    assert.deepEqual(result.feeds.map((row) => row.historicalMonitoringWindowState), [null, "WINDOW_CLOSED", null]);
    assert.equal(result.updatedCount, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, SOURCE_DIR, FEEDS[1].file))).batch, batchBlock());
  }
});

test("mock child timeout waits for actual close before resolving; spawn is hidden and one-shot", async (t) => {
  const f = fixture(t);
  const child = new EventEmitter();
  let resolved = false, killed = false;
  let acknowledgeKill;
  const killRequested = new Promise((resolve) => { acknowledgeKill = resolve; });
  child.kill = () => { killed = true; acknowledgeKill(); };
  const pending = runChild(FEEDS[1].script, f.root, 1, ["--once", "--observation-only"], (exe, args, options) => {
    assert.equal(exe, process.execPath);
    assert.deepEqual(args, [path.join(f.root, "tools", FEEDS[1].script), "--once", "--observation-only"]);
    assert.deepEqual(options, { cwd: f.root, stdio: "ignore", windowsHide: true, shell: false });
    return child;
  }).then((result) => { resolved = true; return result; });
  await killRequested;
  assert.equal(killed, true);
  assert.equal(resolved, false);
  child.emit("exit", null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  child.emit("close", null);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.startFailed, false);
  assert.equal(CHILD_TIMEOUT_MS, 300_000);
});

test("feed-specific timeouts and failures do not suppress the remaining observations", async (t) => {
  for (const failure of [{ exitCode: null, timedOut: true }, { exitCode: null, startFailed: true }, { exitCode: 1 }]) {
    const f = fixture(t);
    const visited = [];
    const result = await runOnce({ ...f, launch: async (script) => {
      visited.push(script);
      if (script === FEEDS[1].script) return failure;
      publish(f, FEEDS.find((feed) => feed.script === script));
      return { exitCode: 0 };
    } });
    assert.deepEqual(visited, FEEDS.map((feed) => feed.script));
    assert.equal(result.status, "FAILED");
    assert.equal(result.updatedCount, 2);
    assert.equal(result.feeds[1].updated, false);
    assert.equal(result.feeds[2].updated, true);
  }
});

test("missing, malformed, renewed or mislabeled multichain metadata never counts as fresh", async (t) => {
  for (const overrides of [{ batch: null }, { batch: { ...batchBlock(), expiresAt: "invalid" } },
    { batch: { ...batchBlock(), expiresAt: "2099-01-01T00:00:00.000Z" } },
    { observationMode: null }, { historicalMonitoringWindowState: "WINDOW_CLOSED" }]) {
    const f = fixture(t);
    const result = await runOnce({ ...f, launch: async (script) => {
      const feed = FEEDS.find((entry) => entry.script === script);
      publish(f, feed, 0, feed.id === "multichain" ? overrides : {});
      return { exitCode: 0 };
    } });
    assert.equal(result.updatedCount, 2);
    assert.equal(result.feeds[1].reason, "OBSERVATION_NOT_UPDATED_OR_INVALID");
    assert.equal(result.feeds[2].updated, true);
  }
});

test("unsupported flags are rejected before any producer starts", async () => {
  for (const args of [["--apply"], ["--loop", "300"], ["--out", "elsewhere"], ["--once", "--once"]]) {
    await assert.rejects(main(args), /USAGE/);
  }
});
