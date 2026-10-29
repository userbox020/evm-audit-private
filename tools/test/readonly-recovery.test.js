"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const recovery = require("../readonly-recovery");

const services = recovery.selectedServices();
const ids = ["dashboard", ...services.map(s => s.id), recovery.SENTINEL.id];
function fixture(initial = ids, configure = () => {}) {
  const present = new Set(initial);
  const calls = { inspections: 0, launches: [], writes: [], sleeps: [], http: 0, reads: [] };
  const state = { now: Date.parse("2026-10-28T12:00:00Z"), prior: null, watchdog: null, duplicate: null, rows: [], tasks: {}, inspectionOk: true, legacy: false, occupied: false, persistLaunch: true, failLaunch: false };
  configure(state);
  const deps = {
    clock: () => state.now,
    sleep: async ms => { calls.sleeps.push(ms); state.now += ms; },
    inspect: async () => {
      calls.inspections++;
      const rows = [...services, recovery.SENTINEL].filter(s => present.has(s.id)).map(s => ({ CommandLine: `node.exe "${path.join(recovery.ROOT, s.script)}" ${s.args.join(" ")}` }));
      if (state.duplicate) rows.push({ CommandLine: `node.exe "${path.join(recovery.ROOT, state.duplicate.script)}"` });
      rows.push(...state.rows);
      const task = id => ({ taskId: recovery.TASK_IDS[id], state: "READY", enabled: true, ...state.tasks[id] });
      return { ok: state.inspectionOk, rows, jobs: Object.keys(recovery.TASK_IDS).filter(id => id !== "dashboard").map(id => ({ id, schedule: task(id) })),
        dashboardTask: task("dashboard"), dashboard: { count: present.has("dashboard") ? 1 : 0, occupied: present.has("dashboard") || state.occupied, python: "C:\\Program Files\\Python313\\python.exe" }, legacyStartup: state.legacy };
    },
    launch: id => {
      calls.launches.push(id);
      if (state.failLaunch) return { status: 1, error: new Error("PRIVATE_ERROR_MUST_NOT_ESCAPE") };
      if (state.persistLaunch) present.add(id);
      return { status: 0 };
    },
    http: async () => { calls.http++; return { state: "RESPONDING", sourcesAvailable: true, error: "PRIVATE_HEALTH_DETAIL" }; },
    statusIO: {
      read: kind => {
        calls.reads.push(kind);
        if (kind === "recovery") return state.prior;
        if (kind === "watchdog") return state.watchdog;
        if (kind === "health") return { generatedAt: new Date(state.now).toISOString(), summary: { status: "fail-closed", persistentExpected: 10, persistentRunning: 10, persistentReady: 7, persistentObservational: 1, error: "PRIVATE_DETAIL" } };
        throw new Error("UNEXPECTED_READ");
      },
      write: value => calls.writes.push(JSON.parse(JSON.stringify(value))),
    },
  };
  return { deps, calls, state, present };
}

test("strict default check and import-inert module", () => {
  assert.deepEqual(recovery.parseOptions(), { apply: false });
  assert.deepEqual(recovery.parseOptions(["--apply"]), { apply: true });
  for (const flags of [["--bad"], ["--check", "--apply"], ["--apply", "--apply"], ["--check", "extra"]]) assert.throws(() => recovery.parseOptions(flags));
  const child = require("node:child_process");
  const http = require("node:http");
  const oldSpawn = child.spawnSync, oldExec = child.execFileSync, oldGet = http.get, oldWrite = fs.writeFileSync;
  const trap = () => { throw new Error("IMPORT_SIDE_EFFECT"); };
  try {
    child.spawnSync = child.execFileSync = http.get = fs.writeFileSync = trap;
    delete require.cache[require.resolve("../readonly-recovery")];
    assert.equal(require("../readonly-recovery").selectedServices().length, 10);
  } finally { child.spawnSync = oldSpawn; child.execFileSync = oldExec; http.get = oldGet; fs.writeFileSync = oldWrite; delete require.cache[require.resolve("../readonly-recovery")]; }
  assert.equal(Object.keys(require.cache).some(key => /(?:execute-top-whale-trigger|watch-top-whale-triggers|live-execution-batch)\.js$/.test(key)), false);
});

test("check performs zero writes and launches even when all twelve are absent", async () => {
  const f = fixture([]);
  const result = await recovery.runRecovery({}, f.deps);
  assert.equal(result.reason, "CHECK_ONLY");
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.calls.launches.length, 0);
  assert.equal(f.calls.http, 1);
  assert.equal(f.calls.inspections, 1);
  assert.equal(result.monitorHealth.persistentReady, 7);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("partial ten-monitor set restores only missing manifest services", async () => {
  const missing = [services[2].id, services[5].id, services[8].id];
  const f = fixture(ids.filter(id => !missing.includes(id)));
  const result = await recovery.runRecovery({ apply: true }, f.deps);
  assert.deepEqual(f.calls.launches, missing);
  assert.equal(result.reason, "BOUNDED_COMPLETE");
  assert.equal(recovery.exitCode(result), 0);
  assert.equal(result.monitorHealth.status, "fail-closed");
});

test("four-pass scoped cold recovery has at most three launches/pass and no duplicates", async () => {
  const f = fixture([]);
  const result = await recovery.runRecovery({ apply: true }, f.deps);
  assert.equal(result.passes, 4);
  assert.equal(f.calls.inspections, 5);
  assert.deepEqual(f.calls.launches, ids);
  assert.equal(new Set(f.calls.launches).size, 12);
  assert.equal(result.reason, "BOUNDED_COMPLETE");
  const perPass = new Map();
  for (const write of f.calls.writes.filter(w => w.services.some(s => s.state === "ATTEMPTING"))) perPass.set(write.passes, (perPass.get(write.passes) || 0) + 1);
  assert.deepEqual([...perPass.values()], [3, 3, 3, 3]);
});

test("unknown inspection, duplicate exact script, and sentinel mode drift refuse all launches", async () => {
  for (const [configure, expected] of [
    [state => { state.inspectionOk = false; }, "INSPECTION_FAILED"],
    [state => { state.duplicate = services[0]; }, "DUPLICATES_REFUSED"],
    [state => { state.rows = [{ CommandLine: `node.exe tools/watch-top-whale-triggers.js --once` }]; }, "SENTINEL_MODE_REFUSED"],
    [state => { state.tasks["monitor-set"] = { state: "UNKNOWN" }; }, "INSPECTION_FAILED"],
  ]) {
    const f = fixture(ids.filter(id => id !== recovery.SENTINEL.id), configure);
    const result = await recovery.runRecovery({ apply: true }, f.deps);
    assert.equal(result.reason, expected);
    assert.equal(f.calls.launches.length, 0);
  }
});

test("check reports legacy running/queued startup or watchdog immediately without waiting or writes", async () => {
  for (const configure of [
    s => { s.tasks["monitor-set"] = { state: "RUNNING" }; },
    s => { s.tasks["monitor-set-watchdog"] = { state: "QUEUED" }; },
    s => { s.rows = [{ CommandLine: "node.exe tools/monitor-set-watchdog.js --apply" }]; },
    s => { s.legacy = true; },
  ]) {
    const f = fixture([], configure);
    const result = await recovery.runRecovery({}, f.deps);
    assert.equal(result.reason, "LEGACY_STARTUP_DEFERRED");
    assert.equal(f.calls.launches.length, 0);
    assert.equal(f.calls.sleeps.length, 0);
    assert.equal(f.calls.writes.length, 0);
    assert.equal(f.calls.inspections, 1);
  }
});

test("apply waits for legacy startup to become quiet then recovers only the sentinel", async () => {
  const f = fixture(ids.filter(id => id !== recovery.SENTINEL.id), s => { s.tasks["monitor-set"] = { state: "RUNNING" }; });
  const inspect = f.deps.inspect;
  f.deps.inspect = async () => {
    if (f.calls.inspections === 2) f.state.tasks["monitor-set"] = { state: "READY" };
    return inspect();
  };
  const sleep = f.deps.sleep;
  f.deps.sleep = async ms => {
    if (f.state.tasks["monitor-set"].state === "RUNNING") {
      assert.equal(f.calls.launches.length, 0);
      assert.equal(f.calls.writes.length, 0);
    }
    await sleep(ms);
  };
  const result = await recovery.runRecovery({ apply: true }, f.deps);
  assert.deepEqual(f.calls.launches, [recovery.SENTINEL.id]);
  assert.deepEqual(f.calls.sleeps, [5000, 5000, 2000]);
  assert.equal(result.reason, "BOUNDED_COMPLETE");
  assert.equal(f.calls.writes[0].passes, 1);
  assert.equal(recovery.exitCode(result), 0);
});

test("permanently busy legacy startup reaches the deadline without launches, passes or backoff changes", async () => {
  const f = fixture([], s => {
    s.tasks["monitor-set-watchdog"] = { state: "QUEUED" };
    s.prior = { schema: "readonly-recovery/v1", services: [{ id: recovery.SENTINEL.id, attempts: 2, lastAttemptAt: "2026-10-28T11:59:00Z", nextEligibleAt: "2026-10-28T12:19:00Z" }] };
  });
  const started = f.state.now;
  const result = await recovery.runRecovery({ apply: true }, f.deps);
  assert.equal(result.reason, "TIME_LIMIT");
  assert.equal(recovery.exitCode(result), 1);
  assert.equal(f.state.now - started, recovery.MAX_RUNTIME_MS);
  assert.equal(f.calls.launches.length, 0);
  assert.equal(result.passes, 0);
  assert.ok(f.calls.sleeps.every(ms => ms > 0 && ms <= 5000));
  const row = result.services.find(s => s.id === recovery.SENTINEL.id);
  assert.equal(row.attempts, 2);
  assert.equal(row.nextEligibleAt, "2026-10-28T12:19:00.000Z");
});

test("sentinel canonical arguments independently match an existing --watch 20 process, not --watch20", async () => {
  assert.deepEqual(recovery.SENTINEL.args, ["--watch", "20"]);
  for (const [args, reason] of [["--watch 20", "CHECK_ONLY"], ["--watch20", "SENTINEL_MODE_REFUSED"]]) {
    const f = fixture(ids.filter(id => id !== recovery.SENTINEL.id), s => {
      s.rows = [{ CommandLine: `"C:\\Program Files\\nodejs\\node.exe" "${path.join(recovery.ROOT, "tools/watch-top-whale-triggers.js")}" ${args}` }];
    });
    const result = await recovery.runRecovery({}, f.deps);
    assert.equal(result.reason, reason);
    assert.equal(f.calls.launches.length, 0);
    assert.equal(f.calls.writes.length, 0);
    if (args === "--watch 20") assert.equal(result.services.find(row => row.id === recovery.SENTINEL.id).state, "PRESENT");
  }
});

test("disabled linked tasks are holds, with no direct fallback", async () => {
  for (const task of ["monitor-set", "monitor-set-watchdog"]) {
    const f = fixture(["dashboard"], s => { s.tasks[task] = { state: "DISABLED", enabled: false }; });
    const result = await recovery.runRecovery({ apply: true }, f.deps);
    assert.equal(f.calls.launches.length, 0);
    assert.equal(result.services.filter(row => row.state === "HELD_DISABLED").length, 11);
  }
  const f = fixture(ids.filter(id => !["dashboard", "venus-psr-multichain"].includes(id)), s => {
    s.tasks.dashboard = s.tasks["venus-psr-multichain"] = { state: "DISABLED", enabled: false };
  });
  await recovery.runRecovery({ apply: true }, f.deps);
  assert.equal(f.calls.launches.length, 0);
});

test("executor catalog alias is never sentinel presence or launch authority", async () => {
  const f = fixture(ids.filter(id => id !== recovery.SENTINEL.id), s => {
    s.rows = [{ CommandLine: "node.exe tools/execute-top-whale-trigger.js --watch5 --execute" },
      { CommandLine: 'node.exe other.js "tools/watch-top-whale-triggers.js" --watch 20' }];
  });
  const result = await recovery.runRecovery({ apply: true }, f.deps);
  assert.deepEqual(f.calls.launches, [recovery.SENTINEL.id]);
  assert.equal(result.liveExecutions, "EXCLUDED_HELD");
  assert.equal(result.liveHold, "BATCH_TARGET_NOT_APPROVED");
  assert.equal(JSON.stringify(result).includes("--execute"), false);
});

test("occupied dashboard port is never restarted or taken over", async () => {
  const f = fixture(ids.filter(id => id !== "dashboard"), s => { s.occupied = true; });
  const result = await recovery.runRecovery({ apply: true }, f.deps);
  assert.equal(f.calls.launches.length, 0);
  assert.equal(result.services[0].state, "PORT_OCCUPIED");
  assert.equal(recovery.exitCode(result), 1);
});

test("no progress or first failure stops rather than relaunching or spending more slots", async () => {
  const f = fixture([], s => { s.persistLaunch = false; });
  const result = await recovery.runRecovery({ apply: true }, f.deps);
  assert.equal(result.reason, "NO_PROGRESS");
  assert.equal(f.calls.launches.length, 3);
  const bad = fixture([], s => { s.failLaunch = true; });
  const failed = await recovery.runRecovery({ apply: true }, bad.deps);
  assert.equal(failed.reason, "LAUNCH_FAILED");
  assert.equal(bad.calls.launches.length, 1);
  assert.equal(failed.services[0].attempts, 1);
  assert.equal(JSON.stringify(failed).includes("PRIVATE"), false);
});

test("prior watchdog/recovery cooldown and attempts survive partial runs", async () => {
  const f = fixture(ids.filter(id => id !== services[0].id), s => {
    s.watchdog = { schema: "monitor-set-watchdog-status/v1", services: [{ id: services[0].id, attempts: 2, lastAttemptAt: "2026-10-28T11:58:00Z", nextEligibleAt: "2026-10-28T12:08:00Z" }] };
    s.prior = { schema: "readonly-recovery/v1", services: [{ id: services[0].id, attempts: 1, lastAttemptAt: "2026-10-28T11:59:00Z", nextEligibleAt: "2026-10-28T12:04:00Z" }] };
  });
  const result = await recovery.runRecovery({ apply: true }, f.deps);
  assert.equal(f.calls.launches.length, 0);
  const row = result.services.find(s => s.id === services[0].id);
  assert.equal(row.state, "COOLDOWN");
  assert.equal(row.attempts, 2);
  assert.equal(row.nextEligibleAt, "2026-10-28T12:08:00.000Z");
});

test("inspection failure preserves attempts; corrupt prior state is not overwritten", async () => {
  const f = fixture([], s => {
    s.inspectionOk = false;
    s.prior = { schema: "readonly-recovery/v1", services: [{ id: services[0].id, attempts: 3, lastAttemptAt: "2026-10-28T11:59:00Z", nextEligibleAt: "2026-10-28T12:19:00Z" }] };
  });
  const failed = await recovery.runRecovery({ apply: true }, f.deps);
  assert.equal(failed.reason, "INSPECTION_FAILED");
  assert.equal(failed.services.find(row => row.id === services[0].id).attempts, 3);
  assert.equal(f.calls.writes.at(-1).services.find(row => row.id === services[0].id).attempts, 3);
  const corrupt = fixture([], s => { s.prior = { schema: "INVALID" }; });
  const refused = await recovery.runRecovery({ apply: true }, corrupt.deps);
  assert.equal(refused.reason, "STATUS_READ_FAILED");
  assert.equal(corrupt.calls.writes.length, 0);
  assert.equal(corrupt.calls.launches.length, 0);
});

test("successful observation resets retry budget rather than imposing a lifetime reboot cap", async () => {
  const f = fixture(ids, s => {
    s.prior = { schema: "readonly-recovery/v1", services: [{ id: services[0].id, attempts: 5, lastAttemptAt: "2026-10-28T11:59:00Z", nextEligibleAt: "2026-10-28T12:59:00Z" }] };
  });
  const result = await recovery.runRecovery({ apply: true }, f.deps);
  assert.equal(result.services.find(row => row.id === services[0].id).attempts, 0);
  assert.equal(f.calls.launches.length, 0);
});

test("fixed hidden payloads use minimal environment and never inherited injection", () => {
  const calls = [];
  const options = { env: { SystemRoot: "C:\\Windows", PATH: "safe", TEMP: "temp", NODE_OPTIONS: "injection", NODE_PATH: "injection", PRIVATE_KEY: "example", RPC_URL: "example", AAVE_V4_FAMILY_INJECTION: "injection" },
    spawnImpl: (exe, args, opts) => { calls.push({ exe, args, opts }); return { status: 0 }; } };
  for (const id of [services[0].id, recovery.SENTINEL.id, "dashboard"]) recovery.launch(id, { python: "C:\\Program Files\\Python313\\python.exe" }, options);
  for (const call of calls) {
    assert.match(call.exe, /wscript\.exe$/);
    const payload = JSON.parse(Buffer.from(call.args[3], "base64").toString("utf8"));
    assert.equal(payload.wait, false);
    assert.equal(payload.workingDirectory, recovery.ROOT);
    assert.equal(call.opts.stdio, "ignore");
    assert.equal(call.opts.windowsHide, true);
    assert.deepEqual(Object.keys(call.opts.env).sort(), ["PATH", "SystemRoot", "TEMP"]);
    assert.deepEqual(payload.environmentNames.sort(), ["PATH", "SystemRoot", "TEMP"]);
  }
  const sentinel = JSON.parse(Buffer.from(calls[1].args[3], "base64").toString());
  assert.match(sentinel.arguments, /watch-top-whale-triggers\.js" "--watch" "20"$/);
  const dashboard = JSON.parse(Buffer.from(calls[2].args[3], "base64").toString());
  assert.match(dashboard.arguments, /^-E -B ".*run-dashboard-task\.py"$/);
  assert.throws(() => recovery.launch("top-whale-trigger-executor", {}, options));
});

test("canary scheduling is observational only; health bounds and no cleanup/control APIs", async () => {
  const f = fixture(ids, s => { s.tasks["canary-feeds"] = { state: "READY", enabled: true }; });
  const result = await recovery.runRecovery({ apply: true }, f.deps);
  assert.equal(f.calls.launches.length, 0);
  assert.equal(result.schedules["canary-feeds"].state, "READY");
  assert.equal(result.canary, "SCHEDULE_ONLY_NO_LOCK_OR_WINDOW_CHANGES");
  assert.deepEqual(new Set(f.calls.reads), new Set(["recovery", "watchdog", "health"]));
  const value = recovery.healthView({ generatedAt: "2020-01-01T00:00:00Z", summary: { status: "PRIVATE", persistentReady: 999 } }, Date.now());
  assert.equal(value.freshness, "STALE");
  assert.equal(value.status, "UNKNOWN");
  assert.equal(value.persistentReady, null);
  const source = fs.readFileSync(path.join(__dirname, "../readonly-recovery.js"), "utf8");
  assert.doesNotMatch(source, /(?:rmSync|unlinkSync|renameSync|Start-ScheduledTask|Stop-ScheduledTask|Enable-ScheduledTask|archiveLock|start-dashboard-live)/);
  assert.doesNotMatch(source, /require\(["'][^"']*(?:executor|execute-|live-execution|watch-top-whale)[^"']*["']\)/);
});
