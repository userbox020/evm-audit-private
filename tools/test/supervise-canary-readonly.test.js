"use strict";

// Offline fixtures only. A local IPC child is forked; no CLI or producer is launched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { spawn: nodeSpawn, spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { preflightReadonlyCanary: preflight, startReadonlyCanary: start, parseCli, assertLaunchBaseline } =
  require("../supervise-canary-readonly.js");
const { acquireCanaryOutputOwner, LOCK_NAME } = require("../lib/canary-output-owner.js");
const { STOP_MESSAGE_TYPE } = require("../lib/canary-readonly-stop.js");

const NOW = Date.parse("2026-09-26T12:00:01.000Z");
const AT = "2026-09-26T12:00:00.000Z";
const RUN = "2026-09-26T12-00-00-000Z";
const HISTORY = { dedicated: "history.json", multichain: "history-multichain.json",
  divergence: "history-divergence.json" };
const SCHEMA = { dedicated: ["exploit-rearm-canary/v1", "exploit-rearm-canary-history/v1"],
  multichain: ["exploit-rearm-canary-multichain/v1", "exploit-rearm-canary-multichain-history/v1"],
  divergence: ["oracle-divergence-monitor/v1", "oracle-divergence-monitor-history/v1"] };
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canary-supervisor-offline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselinePath = path.join(root, "coverage-r3.json");
  const wrapperDir = path.join(root, "wrapper");
  fs.mkdirSync(wrapperDir);
  const directories = {};
  const records = [];
  for (const [surface, chainId, names] of [["dedicated", 1, ["alpha", "beta"]],
    ["multichain", 8453, ["gamma"]], ["divergence", 42161, ["delta"]]]) {
    const dir = path.join(root, surface);
    fs.mkdirSync(dir);
    directories[surface] = dir;
    for (const name of names) records.push({ source: surface, chainId, id: name, schema: SCHEMA[surface][0] });
    write(path.join(dir, "status.json"), { schema: SCHEMA[surface][0], runId: RUN,
      generatedAt: AT, ...(surface === "dedicated" ? { chainId } : {}),
      sentinels: names.map((name) => ({ sentinel: name, ...(surface === "dedicated" ? {} : { chainId }),
        ok: true, fired: false })), firedCount: 0, firedSentinels: [], verdict: "DORMANT" });
    write(path.join(dir, HISTORY[surface]), { schema: SCHEMA[surface][1],
      runs: [{ runId: RUN, at: AT, verdict: "DORMANT", fired: [] }] });
  }
  write(baselinePath, { schema: "all-sentinels-coverage/v1", records });
  const config = { baselinePath, wrapperDir, directories, nowMs: NOW };
  const status = (surface) => path.join(directories[surface], "status.json");
  const history = (surface) => path.join(directories[surface], HISTORY[surface]);
  const edit = (file, modify) => { const value = JSON.parse(fs.readFileSync(file)); modify(value); write(file, value); };
  return { config, root, status, history, edit };
}

test("require has no launch; isolated seeded preflight creates no output and fixed disabled plan", (t) => {
  const { config, status, history } = fixture(t);
  const result = preflight(config);
  assert.equal(result.state, "PREFLIGHT_ONLY_LIFECYCLE_DISABLED");
  assert.equal(result.trackedBaselineCount, 4); // not a dynamic 421 assumption
  assert.deepEqual(result.sourceRowCounts, { dedicated: 2, multichain: 1, divergence: 1 });
  assert.equal(result.coverageComplete, true);
  for (const field of ["routeProven", "profitProven", "dispatchAllowed"]) assert.equal(result[field], false);
  assert.equal(result.noSpawn, true);
  assert.equal(result.noRestart, true);
  assert.equal(fs.existsSync(path.join(config.wrapperDir, LOCK_NAME)), false);
  assert.equal(fs.existsSync(path.join(config.wrapperDir, "supervisor-readonly.json")), false);
  assert.equal(fs.existsSync(path.join(config.wrapperDir, "startup-diagnostic.json")), false);
  for (const [surface, script] of [["dedicated", "monitor-exploit-rearm-canary.js"],
    ["multichain", "monitor-rearm-canary-multichain.js"],
    ["divergence", "monitor-oracle-divergence.js"]]) {
    assert.equal(result.commands[surface].executable, process.execPath);
    assert.equal(path.basename(result.commands[surface].script), script);
    assert.deepEqual(result.commands[surface].args, ["--out", status(surface), "--loop", "60",
      "--keep-watching-on-fire", "--supervised-readonly", "--max-hours", "23",
      ...(surface === "divergence" ? ["--pinned-universe"] : [])]);
    assert.equal(fs.existsSync(history(surface)), true); // preserved, never cleared
  }
});

test("explicit CLI mode: dry-run preflight only, live gate disabled, no canonical defaults", (t) => {
  const { config } = fixture(t);
  assert.throws(() => parseCli([]), { code: "EXPLICIT_MODE_REQUIRED" });
  assert.equal(parseCli(["--run-readonly"]).runReadonly, true);
  assert.throws(() => parseCli(["--preflight", "--run-readonly"]), { code: "EXPLICIT_MODE_REQUIRED" });
  const args = ["--preflight", "--baseline", config.baselinePath,
    "--dedicated-dir", config.directories.dedicated, "--multichain-dir", config.directories.multichain,
    "--divergence-dir", config.directories.divergence, "--wrapper-dir", config.wrapperDir];
  assert.equal(preflight({ ...parseCli(args), nowMs: NOW }).noSpawn, true);
  assert.throws(() => preflight({ ...config, baselinePath: undefined }), { code: "PATHS_REQUIRED" });
});

test("missing/wrong/duplicate or stale seed and partial status-history reject before any lock", (t) => {
  const { config, status, history, edit } = fixture(t);
  fs.rmSync(history("dedicated"));
  assert.throws(() => preflight(config));
  write(history("dedicated"), { schema: SCHEMA.dedicated[1], runs: [
    { runId: RUN, at: AT, verdict: "DORMANT", fired: [] }] });
  edit(status("dedicated"), (s) => { s.sentinels.push({ ...s.sentinels[0] }); });
  assert.throws(() => preflight(config), { code: "SOURCE_DUPLICATE_ID" });
  edit(status("dedicated"), (s) => { s.sentinels.pop(); });
  edit(history("dedicated"), (h) => { h.runs[0].runId = "2026-09-26T11-59-00-000Z"; });
  assert.throws(() => preflight(config), { code: "HISTORY_LATEST_MISMATCH" });
  edit(history("dedicated"), (h) => { h.runs[0].runId = RUN; });
  fs.writeFileSync(status("dedicated"), "{");
  assert.throws(() => preflight(config), { code: "JSON_INVALID" });
  write(status("dedicated"), { schema: SCHEMA.dedicated[0], runId: RUN, generatedAt: AT,
    chainId: 1, sentinels: ["alpha", "beta"].map((sentinel) => ({ sentinel, ok: true, fired: false })),
    firedCount: 0, firedSentinels: [], verdict: "DORMANT" });
  assert.throws(() => preflight({ ...config, nowMs: NOW + 120001 }), { code: "RUN_STALE_OR_INVALID" });
  assert.equal(fs.existsSync(path.join(config.wrapperDir, LOCK_NAME)), false);
});

test("baseline or source missing/new tracked identity IDs refuse preflight", (t) => {
  const { config, status, edit } = fixture(t);
  const baseline = JSON.parse(fs.readFileSync(config.baselinePath));
  baseline.records[0].id = "changed";
  write(config.baselinePath, baseline);
  assert.throws(() => preflight(config), { code: "SEED_IDENTITY_DRIFT" });
  baseline.records[0].id = "alpha";
  write(config.baselinePath, baseline);
  edit(status("dedicated"), (s) => { s.sentinels[0].sentinel = "new"; });
  assert.throws(() => preflight(config), { code: "SEED_IDENTITY_DRIFT" });
  edit(status("dedicated"), (s) => { s.sentinels[0].sentinel = "alpha"; s.sentinels.pop(); });
  assert.throws(() => preflight(config), { code: "SEED_IDENTITY_DRIFT" });
  assert.equal(fs.existsSync(path.join(config.wrapperDir, LOCK_NAME)), false);
});

test("exact tracked IDs with incomplete observation allow degraded no-authority preflight", (t) => {
  const { config, status, edit } = fixture(t);
  edit(status("multichain"), (s) => { s.sentinels[0].ok = false; s.verdict = "INCOMPLETE"; });
  edit(path.join(config.directories.multichain, HISTORY.multichain),
    (h) => { h.runs[0].verdict = "INCOMPLETE"; });
  const result = preflight(config);
  assert.equal(result.state, "PREFLIGHT_DEGRADED_LIFECYCLE_DISABLED");
  assert.equal(result.coverageComplete, false);
  assert.equal(result.trackedBaselineCount, 4);
  assert.deepEqual(result.sourceRowCounts, { dedicated: 2, multichain: 1, divergence: 1 });
  assert.deepEqual(result.surfaces.multichain, { ok: false, fired: false, incomplete: true,
    missingIds: [], newIds: [] });
  assert.equal(result.surfaces.dedicated.ok, true);
  assert.equal(result.noSpawn, true);
  for (const field of ["routeProven", "profitProven", "dispatchAllowed"]) assert.equal(result[field], false);
});

test("FIRED alongside incomplete remains observational, while shared directories reject", (t) => {
  const { config, status, edit } = fixture(t);
  edit(status("dedicated"), (s) => { s.sentinels[0].fired = true; s.sentinels[1].ok = false;
    s.firedCount = 1; s.firedSentinels = ["alpha"]; s.verdict = "FIRED"; });
  const hist = path.join(config.directories.dedicated, HISTORY.dedicated);
  edit(hist, (h) => { h.runs[0].verdict = "FIRED"; h.runs[0].fired = ["alpha"]; });
  const result = preflight(config);
  assert.equal(result.state, "PREFLIGHT_DEGRADED_LIFECYCLE_DISABLED");
  assert.equal(result.coverageComplete, false);
  assert.equal(result.surfaces.dedicated.incomplete, true);
  assert.equal(result.surfaces.dedicated.fired, false);
  assert.deepEqual(result.surfaces.dedicated.missingIds, []);
  assert.deepEqual(result.surfaces.dedicated.newIds, []);
  assert.equal(result.routeProven, false);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.noSpawn, true);
  assert.throws(() => preflight({ ...config, directories: { ...config.directories,
    multichain: config.directories.dedicated } }), { code: "DIRECTORIES_NOT_ISOLATED" });
});

test("pre-existing producer lock and duplicate wrapper are never stolen or deleted", (t) => {
  const { config } = fixture(t);
  const producerLock = path.join(config.directories.multichain, LOCK_NAME);
  fs.mkdirSync(producerLock);
  fs.writeFileSync(path.join(producerLock, "owner.json"), "unknown owner");
  assert.throws(() => preflight(config), { code: "PRODUCER_LOCK_PRESENT" });
  assert.equal(fs.readFileSync(path.join(producerLock, "owner.json"), "utf8"), "unknown owner");
  fs.rmSync(producerLock, { recursive: true });
  const owner = acquireCanaryOutputOwner(path.join(config.wrapperDir, "other-wrapper.json"));
  assert.throws(() => preflight(config), /EEXIST/);
  owner.check();
  assert.equal(owner.release(), true);
});

test("replaced wrapper lock cannot be removed during preflight release", (t) => {
  const { config } = fixture(t);
  // No interposition on owner internals: an opaque existing lock tests the
  // replacement safety boundary without touching any real producer.
  const lock = path.join(config.wrapperDir, LOCK_NAME);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), "replacement");
  assert.throws(() => preflight(config), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(lock, "owner.json"), "utf8"), "replacement");
});

function simulation(t, tick = 30000, { autoReady = true } = {}) {
  const f = fixture(t);
  let clock = NOW;
  const calls = [];
  const children = [];
  const lock = (surface) => path.join(f.config.directories[surface], LOCK_NAME);
  const clear = (surface) => fs.rmSync(lock(surface), { recursive: true, force: true });
  let onWait = () => {};
  const dependencies = {
    now: () => clock,
    wait: async (ms) => { clock += Math.min(tick, ms); onWait(); },
    stop: (child, callback) => child.send({ type: STOP_MESSAGE_TYPE }, callback),
    spawn(executable, args, options) {
      const surface = ["dedicated", "multichain", "divergence"][children.length];
      const child = new EventEmitter();
      child.pid = 80000 + children.length;
      child.connected = true;
      child.kill = () => { throw Error("force-stop forbidden"); };
      child.send = (message, callback) => {
        assert.deepEqual(message, { type: STOP_MESSAGE_TYPE });
        callback(null);
        child.emit("exit", 0, null);
        clear(surface);
        child.connected = false;
        child.emit("close", 0, null);
        return true;
      };
      calls.push({ executable, args, options });
      children.push(child);
      fs.mkdirSync(lock(surface));
      write(path.join(lock(surface), "owner.json"), { pid: child.pid, token: "a".repeat(64) });
      if (autoReady) process.nextTick(() => child.emit("message", { type: "canary-readonly-ready/v1" }));
      return child;
    },
  };
  return { ...f, dependencies, calls, children, lock, clear,
    onWait: (fn) => { onWait = fn; }, clock: () => clock,
    step: (ms) => { clock += ms; onWait(); } };
}

test("offline start gates invalid seed and existing child lock before any spawn", async (t) => {
  const f = simulation(t);
  f.edit(f.status("dedicated"), (s) => s.sentinels.push({ ...s.sentinels[0] }));
  const bad = await start(f.config, f.dependencies);
  assert.equal(bad.state, "DEGRADED");
  assert.equal(bad.code, "STARTUP_INVALID");
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, "startup-diagnostic.json")), false);
  const other = fixture(t);
  fs.mkdirSync(path.join(other.config.directories.multichain, LOCK_NAME));
  let spawned = 0;
  const verdict = await start(other.config, { ...f.dependencies, spawn: () => { spawned++; } });
  assert.equal(spawned, 0);
  assert.equal(verdict.state, "DEGRADED");
  assert.equal(verdict.code, "ATTENDED_RECOVERY_REQUIRED");
  assert.equal(fs.existsSync(path.join(other.config.directories.multichain, LOCK_NAME)), true);
});

test("unguarded real-start API rejects a self-consistent truncated fixture before spawn", async (t) => {
  const f = simulation(t);
  let spawned = 0;
  await assert.rejects(start(f.config, { ...f.dependencies, stop: undefined,
    spawn: () => { spawned++; throw Error("must not launch"); } }), { code: "GUARDIAN_REQUIRED" });
  assert.equal(spawned, 0);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
});

test("launch authority pins exact workspace path, bytes, 421 IDs and fixed surface counts", () => {
  const canonical = path.resolve(__dirname, "..", "..", "reports", "raw", "fast",
    "all-sentinels-coverage-20260926", "coverage-r3.json");
  const verdict = { hashes: { baseline: "9bd9ddb6a622c3dbfdea0f90e5491374f2473888b1e1d24ef3180d0bf1b9886a" },
    trackedBaselineCount: 421, sourceRowCounts: { dedicated: 3, multichain: 67, divergence: 351 } };
  assert.doesNotThrow(() => assertLaunchBaseline(canonical, verdict));
  assert.throws(() => assertLaunchBaseline(path.resolve("fake.json"), verdict), { code: "LAUNCH_BASELINE_INVALID" });
  assert.throws(() => assertLaunchBaseline(canonical, { ...verdict, trackedBaselineCount: 420 }),
    { code: "LAUNCH_BASELINE_INVALID" });
  assert.throws(() => assertLaunchBaseline(canonical, { ...verdict,
    sourceRowCounts: { ...verdict.sourceRowCounts, divergence: 350 } }), { code: "LAUNCH_BASELINE_INVALID" });
  assert.throws(() => assertLaunchBaseline(canonical, { ...verdict, hashes: { baseline: "0".repeat(64) } }),
    { code: "LAUNCH_BASELINE_INVALID" });
});

test("Oct 8 multichain cutoff refuses a 23-hour child window before any spawn", async (t) => {
  const f = simulation(t);
  f.dependencies.now = () => Date.parse("2026-10-08T00:31:19.237Z") - 23 * 60 * 60 * 1000;
  const result = await start(f.config, f.dependencies);
  assert.equal(result.state, "DEGRADED");
  assert.equal(result.code, "STARTUP_INVALID");
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
});

test("missing explicit paths cannot start or spawn even with IPC support", async () => {
  await assert.rejects(start(), { code: "GUARDIAN_REQUIRED" });
});

test("uncontained CLI rejects missing, legacy and fake V2 locator before wrapper lock", (t) => {
  const f = fixture(t);
  const args = [path.join(__dirname, "..", "supervise-canary-readonly.js"), "--run-readonly",
    "--baseline", f.config.baselinePath, "--dedicated-dir", f.config.directories.dedicated,
    "--multichain-dir", f.config.directories.multichain,
    "--divergence-dir", f.config.directories.divergence, "--wrapper-dir", f.config.wrapperDir];
  const fake = "CANARY_READONLY_GUARDIAN_V2 \\\\.\\pipe\\canary-readonly-guardian-fake-001\n";
  for (const input of ["", "CANARY_READONLY_GUARDIAN_V1\n",
    "CANARY_READONLY_GUARDIAN_V1\nEXTRA", fake, fake + "EXTRA", fake + fake]) {
    // Public markers/locators alone cannot authorize an uncontained launch.
    const result = spawnSync(process.execPath, args, { input, encoding: "utf8", timeout: 17000,
      windowsHide: true });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "READONLY_CANARY_REJECTED");
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
    assert.equal(fs.existsSync(path.join(f.config.wrapperDir, "startup-diagnostic.json")), false);
    for (const dir of Object.values(f.config.directories)) {
      assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
    }
  }
});

test("direct CLI preflight works without guardian stdin", (t) => {
  const f = fixture(t);
  const at = new Date(Date.now() - 1000).toISOString();
  const runId = at.replace(/[:.]/gu, "-");
  for (const surface of ["dedicated", "multichain", "divergence"]) {
    f.edit(f.status(surface), (status) => { status.generatedAt = at; status.runId = runId; });
    f.edit(f.history(surface), (history) => { history.runs[0].at = at; history.runs[0].runId = runId; });
  }
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "supervise-canary-readonly.js"),
    "--preflight", "--baseline", f.config.baselinePath,
    "--dedicated-dir", f.config.directories.dedicated, "--multichain-dir", f.config.directories.multichain,
    "--divergence-dir", f.config.directories.divergence, "--wrapper-dir", f.config.wrapperDir],
  { input: "", encoding: "utf8", timeout: 7000, windowsHide: true });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.noSpawn, true);
  assert.equal(output.trackedBaselineCount, 4);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, "startup-diagnostic.json")), false);
});

test("isolated offline guardian-verification stub records enum-only startup rejection after receipt", async (t) => {
  // VM mocks the native verifier in memory: no guardian executable, producer or RPC is launched.
  const f = fixture(t);
  const at = new Date(Date.now() - 1000).toISOString();
  const runId = at.replace(/[:.]/gu, "-");
  for (const surface of ["dedicated", "multichain", "divergence"]) {
    f.edit(f.status(surface), (s) => { s.generatedAt = at; s.runId = runId; });
    f.edit(f.history(surface), (h) => { h.runs[0].at = at; h.runs[0].runId = runId; });
  }
  const file = path.join(__dirname, "..", "supervise-canary-readonly.js");
  const realRequire = createRequire(file);
  const sandboxModule = { exports: {} };
  let verifyCalls = 0;
  const sandboxRequire = (id) => id === "node:child_process" ? {
    ...realRequire(id), spawnSync(executable, args) {
      assert.equal(path.basename(executable), "canary-readonly-guardian-win32.exe");
      assert.deepEqual(Array.from(args), ["--verify", "\\\\.\\pipe\\canary-readonly-guardian-fixture"]);
      verifyCalls++;
      return { status: 0 };
    },
  } : realRequire(id);
  sandboxRequire.main = sandboxModule;
  const stdin = new EventEmitter();
  stdin.isTTY = false;
  stdin.pause = () => {};
  stdin.resume = () => process.nextTick(() => {
    stdin.emit("data", Buffer.from("CANARY_READONLY_GUARDIAN_V2 \\\\.\\pipe\\canary-readonly-guardian-fixture\n"));
    stdin.emit("end");
  });
  const fakeProcess = new EventEmitter();
  Object.assign(fakeProcess, { platform: "win32", stdin, execPath: process.execPath, env: {},
    argv: [process.execPath, file, "--run-readonly", "--baseline", f.config.baselinePath,
      "--dedicated-dir", f.config.directories.dedicated,
      "--multichain-dir", f.config.directories.multichain,
      "--divergence-dir", f.config.directories.divergence, "--wrapper-dir", f.config.wrapperDir] });
  const output = [];
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module: sandboxModule, require: sandboxRequire, __dirname: path.dirname(file), process: fakeProcess,
    console: { log: (line) => output.push(line), error: (line) => output.push(line) },
    Buffer, setTimeout, clearTimeout, setImmediate, Date,
  }, { filename: file });
  for (let i = 0; i < 100 && fakeProcess.exitCode !== 1; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(verifyCalls, 1);
  assert.equal(fakeProcess.exitCode, 1);
  assert.equal(JSON.parse(output[0]).code, "STARTUP_INVALID");
  const diagnosticPath = path.join(f.config.wrapperDir, "startup-diagnostic.json");
  const bytes = fs.readFileSync(diagnosticPath, "utf8");
  assert.equal(Buffer.byteLength(bytes) < 256, true);
  const diagnostic = JSON.parse(bytes);
  assert.deepEqual(Object.keys(diagnostic), ["phase", "reason", "at"]);
  assert.equal(diagnostic.phase, "EXIT");
  assert.equal(diagnostic.reason, "BASELINE_INVALID");
  assert.equal(new Date(diagnostic.at).toISOString(), diagnostic.at);
  assert.equal(bytes.includes(f.root), false);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
});

test("held-open partial guardian marker times out before any wrapper lock", async (t) => {
  const f = fixture(t);
  const child = nodeSpawn(process.execPath, [path.join(__dirname, "..", "supervise-canary-readonly.js"),
    "--run-readonly", "--baseline", f.config.baselinePath,
    "--dedicated-dir", f.config.directories.dedicated, "--multichain-dir", f.config.directories.multichain,
    "--divergence-dir", f.config.directories.divergence, "--wrapper-dir", f.config.wrapperDir],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let errorOutput = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  child.stdin.write("CANARY_READONLY_GUARDIAN_V1"); // deliberately incomplete, pipe remains open
  const started = performance.now();
  const code = await Promise.race([new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", () => reject(Error("guardian-test-child-error")));
  }), new Promise((_, reject) => setTimeout(() => {
    child.stdin.end();
    reject(Error("guardian-marker-timeout-exceeded"));
  }, 6500))]);
  assert.equal(code, 1);
  assert.equal(performance.now() - started < 6500, true);
  assert.equal(output, "");
  assert.equal(errorOutput.trim(), "READONLY_CANARY_REJECTED");
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, "startup-diagnostic.json")), false);
});

test("all three exact handles are spawned before asynchronously acquired locks are required", async (t) => {
  const f = simulation(t, 30000, { autoReady: false });
  const originalSpawn = f.dependencies.spawn;
  let checks = 0;
  f.dependencies.spawn = (...args) => {
    const child = originalSpawn(...args);
    f.clear(["dedicated", "multichain", "divergence"][f.children.length - 1]);
    return child;
  };
  const signal = new EventEmitter();
  f.dependencies.signal = signal;
  f.onWait(() => {
    assert.equal(f.calls.length, 3);
    if (++checks === 3) {
      for (const [i, surface] of ["dedicated", "multichain", "divergence"].entries()) {
        fs.mkdirSync(f.lock(surface));
        write(path.join(f.lock(surface), "owner.json"), { pid: f.children[i].pid, token: "a".repeat(64) });
        f.children[i].emit("message", { type: "canary-readonly-ready/v1" });
      }
    } else if (checks === 4) signal.emit("SIGINT");
  });
  const result = await start(f.config, f.dependencies);
  assert.equal(result.state, "STOPPED");
  assert.equal(result.code, "SIGNAL_STOP");
  assert.equal(checks >= 4, true);
});

test("early SIGINT before readiness queues IPC stop until exact delayed ACK", async (t) => {
  const f = simulation(t, 30000, { autoReady: false });
  const signal = new EventEmitter();
  f.dependencies.signal = signal;
  const original = f.dependencies.spawn;
  f.dependencies.spawn = (...args) => {
    const child = original(...args);
    if (f.calls.length === 1) process.nextTick(() => signal.emit("SIGINT"));
    return child;
  };
  let ticks = 0;
  f.onWait(() => {
    if (++ticks === 3) for (const child of f.children) {
      child.emit("message", { type: "canary-readonly-ready/v1" });
    }
  });
  const result = await start(f.config, f.dependencies);
  assert.equal(result.state, "STOPPED");
  assert.equal(result.code, "SIGNAL_STOP");
  assert.equal(f.calls.length, 1);
  assert.equal(ticks >= 3, true);
  assert.equal(fs.existsSync(f.lock("dedicated")), false);
});

test("never-ready child is never sent a blind stop and retains attended wrapper lock", async (t) => {
  const f = simulation(t, 30000, { autoReady: false });
  let sent = 0;
  f.dependencies.stop = () => { sent++; throw Error("stop before listener installed"); };
  const result = await start(f.config, f.dependencies);
  assert.equal(result.state, "DEGRADED");
  assert.equal(result.code, "ATTENDED_RECOVERY_REQUIRED");
  assert.equal(f.calls.length, 3);
  assert.equal(sent, 0);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), true);
});

test("malformed ready message never authorizes HEALTHY or stop send", async (t) => {
  const f = simulation(t, 30000, { autoReady: false });
  const original = f.dependencies.spawn;
  f.dependencies.spawn = (...args) => {
    const child = original(...args);
    process.nextTick(() => child.emit("message", { type: "canary-readonly-ready/v1", extra: true }));
    return child;
  };
  let sent = 0;
  f.dependencies.stop = () => { sent++; };
  const result = await start(f.config, f.dependencies);
  assert.equal(result.code, "ATTENDED_RECOVERY_REQUIRED");
  assert.equal(sent, 0);
});

test("interleaved status/history mismatch retries under intact child locks then joins", async (t) => {
  for (const kind of ["mismatch", "partial-json"]) {
    const f = simulation(t);
    const original = fs.readFileSync(f.history("dedicated"));
    const signal = new EventEmitter();
    f.dependencies.signal = signal;
    let checks = 0;
    f.onWait(() => {
      checks++;
      if (checks === 1) {
        if (kind === "mismatch") f.edit(f.history("dedicated"),
          (h) => { h.runs[0].runId = "2026-09-26T11-59-00-000Z"; });
        else fs.writeFileSync(f.history("dedicated"), "{");
      }
      if (checks === 3) fs.writeFileSync(f.history("dedicated"), original);
      if (checks === 4) signal.emit("SIGTERM");
    });
    const result = await start(f.config, f.dependencies);
    assert.equal(result.state, "STOPPED");
    assert.equal(result.code, "SIGNAL_STOP");
    assert.equal(checks >= 4, true);
    assert.equal(f.calls.length, 3);
  }
});

test("fixed three children, minimal environment, joined incomplete observations, expiry and no restart", async (t) => {
  const f = simulation(t, 29 * 60 * 1000);
  f.edit(f.status("multichain"), (s) => { s.sentinels[0].ok = false; s.verdict = "INCOMPLETE"; });
  f.edit(f.history("multichain"), (h) => { h.runs[0].verdict = "INCOMPLETE"; });
  f.onWait(() => {
    const at = new Date(f.clock()).toISOString();
    const runId = at.replace(/[:.]/gu, "-");
    for (const surface of ["dedicated", "multichain", "divergence"]) {
      f.edit(f.status(surface), (s) => { s.runId = runId; s.generatedAt = at; });
      f.edit(f.history(surface), (h) => { h.runs[0].runId = runId; h.runs[0].at = at; });
    }
  });
  f.dependencies.wait = async () => f.step(29 * 60 * 1000);
  const result = await start(f.config, f.dependencies);
  assert.equal(result.state, "STOPPED");
  assert.equal(result.code, "PILOT_EXPIRED");
  assert.equal(result.validatorBoundary, "MINIMAL_SHAPE_JOIN_ONLY");
  assert.equal(result.dispatchAllowed, false);
  assert.equal(f.calls.length, 3);
  for (const [i, surface] of ["dedicated", "multichain", "divergence"].entries()) {
    const command = f.calls[i];
    assert.equal(command.executable, process.execPath);
    assert.equal(command.args[0], "--use-system-ca");
    assert.equal(path.basename(command.args[1]), ["monitor-exploit-rearm-canary.js",
      "monitor-rearm-canary-multichain.js", "monitor-oracle-divergence.js"][i]);
    assert.deepEqual(command.args.slice(2), ["--out", f.status(surface), "--loop", "60",
      "--keep-watching-on-fire", "--supervised-readonly", "--max-hours", "23",
      ...(surface === "divergence" ? ["--pinned-universe"] : [])]);
    assert.deepEqual(Object.keys(command.options.env), process.platform === "win32" && process.env.SystemRoot ? ["SystemRoot"] : []);
    assert.deepEqual(command.options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
    assert.equal(fs.existsSync(f.lock(surface)), false);
  }
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
});

test("one child crash stops all owned handles without restart", async (t) => {
  const f = simulation(t);
  f.onWait(() => { f.children[1].emit("exit", 1, null); f.clear("multichain");
    f.children[1].emit("close", 1, null); });
  const result = await start(f.config, f.dependencies);
  assert.equal(result.state, "DEGRADED");
  assert.equal(result.code, "CHILD_EXIT");
  assert.equal(f.calls.length, 3);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
});

test("exit before close during startup prevents spawning the remaining children", async (t) => {
  const f = simulation(t);
  const original = f.dependencies.spawn;
  f.dependencies.spawn = (...args) => {
    const child = original(...args);
    if (f.children.length === 1) process.nextTick(() => {
      child.emit("exit", 1, null);
      f.clear("dedicated");
      child.emit("close", 1, null);
    });
    return child;
  };
  const result = await start(f.config, f.dependencies);
  assert.equal(result.state, "DEGRADED");
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
});

test("stale source and mismatched history fail closed after startup", async (t) => {
  for (const kind of ["stale", "partial"]) {
    const f = simulation(t, 31 * 60 * 1000);
    if (kind === "partial") f.onWait(() => f.edit(f.history("dedicated"),
      (h) => { h.runs[0].runId = "2026-09-26T11-59-00-000Z"; }));
    const result = await start(f.config, f.dependencies);
    assert.equal(result.state, "DEGRADED");
    assert.equal(result.code, kind === "stale" ? "STATUS_STALE" : "JOIN_RETRY_EXPIRED");
    assert.equal(f.calls.length, 3);
  }
});

test("unknown stop retains wrapper lock for attended recovery, without force kill", async (t) => {
  const f = simulation(t, 15000);
  let emitted = false;
  f.onWait(() => { if (!emitted && f.clock() >= NOW + 30000) {
    emitted = true;
    f.children[0].emit("error", Error("secret material must not surface"));
  } });
  f.dependencies.stop = () => true; // never confirms an exit
  const result = await start(f.config, f.dependencies);
  assert.deepEqual({ state: result.state, code: result.code },
    { state: "DEGRADED", code: "ATTENDED_RECOVERY_REQUIRED" });
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), true);
});

test("IPC callback transport error is sanitized even when child closes and releases lock", async (t) => {
  const f = simulation(t);
  const original = f.dependencies.spawn;
  f.dependencies.spawn = (...args) => {
    const child = original(...args);
    if (f.children.length === 2) {
      const send = child.send;
      child.send = (message, callback) => send(message, () => callback(Error("raw private transport detail")));
    }
    return child;
  };
  const signal = new EventEmitter();
  f.dependencies.signal = signal;
  f.onWait(() => signal.emit("SIGINT"));
  const verdict = await start(f.config, f.dependencies);
  assert.equal(verdict.state, "DEGRADED");
  assert.equal(verdict.code, "CHILD_STOP_ERROR");
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
});

test("child exit without close cannot certify graceful shutdown", async (t) => {
  const f = simulation(t);
  const original = f.dependencies.spawn;
  f.dependencies.spawn = (...args) => {
    const child = original(...args);
    if (f.children.length === 1) child.send = (message, callback) => {
      assert.deepEqual(message, { type: STOP_MESSAGE_TYPE });
      callback(null);
      child.emit("exit", 0, null);
      f.clear("dedicated");
      return true;
    };
    return child;
  };
  const signal = new EventEmitter();
  f.dependencies.signal = signal;
  f.onWait(() => signal.emit("SIGTERM"));
  const verdict = await start(f.config, f.dependencies);
  assert.equal(verdict.state, "DEGRADED");
  assert.equal(verdict.code, "ATTENDED_RECOVERY_REQUIRED");
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), true);
});

test("real local Node IPC fixtures release three owned locks before close", async (t) => {
  const f = fixture(t);
  const signal = new EventEmitter();
  const children = [];
  const fixtureScript = path.join(__dirname, "fixtures", "canary-readonly-ipc-child.js");
  let stopRequested = false;
  const result = await start(f.config, {
    now: () => NOW,
    elapsed: () => performance.now(),
    signal,
    wait: (ms) => new Promise((resolve) => setTimeout(() => {
      if (!stopRequested && ["dedicated", "multichain", "divergence"].every((surface) =>
        fs.existsSync(path.join(f.config.directories[surface], LOCK_NAME)))) {
        stopRequested = true;
        signal.emit("SIGTERM");
      }
      resolve();
    }, Math.min(ms, 10))),
    stop: (child, callback) => child.send({ type: STOP_MESSAGE_TYPE }, callback),
    spawn(executable, args, options) {
      assert.equal(executable, process.execPath);
      assert.equal(args[0], "--use-system-ca");
      assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
      const surface = ["dedicated", "multichain", "divergence"][children.length];
      assert.equal(args[3], f.status(surface));
      const child = nodeSpawn(executable, ["--use-system-ca", fixtureScript, "--out", f.status(surface),
        "--delay-ready-ms", "300"], options);
      children.push(child);
      return child;
    },
  });
  assert.equal(result.state, "STOPPED");
  assert.equal(result.code, "SIGNAL_STOP");
  assert.equal(children.length, 3);
  assert.equal(children.every((child) => child.exitCode === 0 && !child.connected), true);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
  for (const surface of ["dedicated", "multichain", "divergence"]) {
    assert.equal(fs.existsSync(path.join(f.config.directories[surface], LOCK_NAME)), false);
  }
});

test("staggered local IPC READY has an external watchdog", () => {
  // This subprocess has its own event loop; a permanently resolved wake can
  // starve timers and IPC there without freezing the parent test process.
  const run = spawnSync(process.execPath, ["--test", "--test-name-pattern=^staggered local IPC READY inner$",
    __filename], { env: { ...(process.platform === "win32" && process.env.SystemRoot ?
      { SystemRoot: process.env.SystemRoot } : {}), CANARY_STAGGERED_INNER: "1" },
    encoding: "utf8", windowsHide: true, timeout: 9000 });
  assert.equal(run.error, undefined, `offline watchdog: ${run.error?.code || "none"}`);
  assert.equal(run.status, 0, `offline IPC regression failed: ${run.signal || run.status}`);
  assert.match(run.stdout, /✔ staggered local IPC READY inner/u);
});

if (process.env.CANARY_STAGGERED_INNER === "1") {
  test("staggered local IPC READY inner", async (t) => {
    const f = fixture(t);
    const signal = new EventEmitter();
    const children = [];
    const fixtureScript = path.join(__dirname, "fixtures", "canary-readonly-ipc-child.js");
    const delays = [0, 200, 700];
    let readyAcks = 0;
    let joinedBeforeStop = false;
    let stopped = false;
    const result = await start(f.config, {
      now: () => NOW,
      elapsed: () => performance.now(),
      signal,
      wait: (ms) => new Promise((resolve) => setTimeout(() => {
        if (readyAcks === 3 && !stopped) {
          joinedBeforeStop = true; // monitoring wait only begins after READY and first successful join
          stopped = true;
          signal.emit("SIGTERM");
        }
        resolve();
      }, Math.min(ms, 50))),
      stop: (child, callback) => child.send({ type: STOP_MESSAGE_TYPE }, callback),
      spawn(executable, args, options) {
        const index = children.length;
        assert.equal(index < 3, true);
        assert.equal(executable, process.execPath);
        assert.equal(args[0], "--use-system-ca");
        assert.equal(args[3], f.status(["dedicated", "multichain", "divergence"][index]));
        assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
        assert.deepEqual(options.env, process.platform === "win32" && process.env.SystemRoot ?
          { SystemRoot: process.env.SystemRoot } : {});
        const child = nodeSpawn(executable, ["--use-system-ca", fixtureScript, "--out",
          args[3], "--delay-ready-ms", String(delays[index])], options);
        child.on("message", (message) => {
          if (message?.type === "canary-readonly-ready/v1") readyAcks++;
        });
        children.push(child);
        return child;
      },
    });
    assert.equal(readyAcks, 3);
    assert.equal(joinedBeforeStop, true);
    assert.equal(result.state, "STOPPED");
    assert.equal(result.code, "SIGNAL_STOP");
    assert.equal(children.length, 3);
    assert.equal(children.every((child) => child.exitCode === 0 && !child.connected), true);
    assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), false);
    for (const surface of ["dedicated", "multichain", "divergence"]) {
      assert.equal(fs.existsSync(path.join(f.config.directories[surface], LOCK_NAME)), false);
    }
  });
}

test("local fixture releases its lock on parent IPC disconnect before ready", async (t) => {
  const f = fixture(t);
  const child = nodeSpawn(process.execPath, ["--use-system-ca",
    path.join(__dirname, "fixtures", "canary-readonly-ipc-child.js"), "--out",
    f.status("dedicated"), "--delay-ready-ms", "1000"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    env: process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
  });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(Error("fixture-exit-failed")));
    child.once("error", () => reject(Error("fixture-start-failed")));
  });
  const lock = path.join(f.config.directories.dedicated, LOCK_NAME);
  for (let i = 0; i < 200 && !fs.existsSync(lock); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(lock), true);
  // The file is acquired just before the fixture installs its disconnect
  // listener; allow its synchronous setup to finish, still before ready.
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.disconnect();
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() =>
    reject(Error("fixture-disconnect-timeout")), 3000))]);
  assert.equal(fs.existsSync(lock), false);
});

test("replaced wrapper lock is never removed and drifted child lock triggers stop", async (t) => {
  const f = simulation(t);
  f.onWait(() => {
    fs.rmSync(path.join(f.config.wrapperDir, LOCK_NAME), { recursive: true });
    fs.mkdirSync(path.join(f.config.wrapperDir, LOCK_NAME));
    write(path.join(f.config.wrapperDir, LOCK_NAME, "owner.json"), { replacement: true });
  });
  const result = await start(f.config, f.dependencies);
  assert.equal(result.state, "DEGRADED");
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME, "owner.json")), true);
});

test("child lock replacement and baseline pin drift require attended recovery", async (t) => {
  const f = simulation(t);
  let changed = false;
  f.onWait(() => {
    if (changed) return;
    changed = true;
    f.clear("dedicated");
    fs.mkdirSync(f.lock("dedicated"));
    write(path.join(f.lock("dedicated"), "owner.json"), { pid: f.children[0].pid,
      token: "b".repeat(64) });
  });
  f.dependencies.stop = (child, callback, surface) => {
    callback(null);
    child.emit("exit", 0, null);
    if (surface !== "dedicated") f.clear(surface);
    child.emit("close", 0, null);
    return true;
  };
  const verdict = await start(f.config, f.dependencies);
  assert.equal(verdict.code, "ATTENDED_RECOVERY_REQUIRED");
  assert.equal(fs.existsSync(f.lock("dedicated")), true);
  assert.equal(fs.existsSync(path.join(f.config.wrapperDir, LOCK_NAME)), true);

  const next = simulation(t);
  next.onWait(() => next.edit(next.config.baselinePath, (data) => { data.pin = "changed"; }));
  const drift = await start(next.config, next.dependencies);
  assert.equal(drift.state, "DEGRADED");
  assert.equal(drift.code, "OBSERVATION_DRIFT");
});

test("SIGTERM stops only three owned children and preserves no dispatch authority", async (t) => {
  const f = simulation(t);
  const signal = new EventEmitter();
  f.dependencies.signal = signal;
  f.onWait(() => signal.emit("SIGTERM"));
  const verdict = await start(f.config, f.dependencies);
  assert.equal(verdict.state, "STOPPED");
  assert.equal(verdict.code, "SIGNAL_STOP");
  assert.equal(f.calls.length, 3);
  assert.equal(verdict.dispatchAllowed, false);
  assert.equal(verdict.profitProven, false);
  assert.equal(verdict.routeProven, false);
  assert.equal(signal.listenerCount("SIGTERM"), 0);
});
