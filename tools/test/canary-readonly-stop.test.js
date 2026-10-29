"use strict";

// Local-only: this file forks itself as an IPC fixture, never a producer or RPC client.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter, once } = require("node:events");
const { fork, spawnSync } = require("node:child_process");
const { acquireCanaryOutputOwner, LOCK_NAME } = require("../lib/canary-output-owner.js");
const { installCanaryReadOnlyStop, STOP_MESSAGE_TYPE, READY_MESSAGE_TYPE } = require("../lib/canary-readonly-stop.js");

if (process.argv[2] === "--ipc-fixture") {
  // Hold the real output lock until the cooperative stop wakes the fixture.
  const owner = acquireCanaryOutputOwner(path.join(process.argv[3], "status.json"));
  let wake;
  let stopping = false;
  const stop = () => { stopping = true; if (wake) wake(); };
  const start = () => {
    const dispose = installCanaryReadOnlyStop(stop, process, true);
    (async () => {
    try {
      owner.check();
      await new Promise((resolve) => { wake = resolve; if (stopping) resolve(); });
    } finally {
      dispose();
      if (!owner.release()) throw Error("owner-not-released");
    }
    })().catch(() => { process.exitCode = 1; });
  };
  if (process.argv[4] === "pause-before-install") {
    process.once("disconnect", () => setImmediate(start));
    process.send({ type: "preinstall" });
  } else start();
} else {
  function fakeIpc(connected = true) {
    const proc = new EventEmitter();
    proc.channel = {};
    proc.connected = connected;
    return proc;
  }

  test("only the exact fork IPC stop request stops; dispose removes both listeners", () => {
    const proc = fakeIpc();
    let calls = 0;
    const dispose = installCanaryReadOnlyStop(() => { calls++; }, proc);
    proc.emit("message", "canary-readonly-stop/v1");
    proc.emit("message", { type: "unrelated" });
    proc.emit("message", { type: STOP_MESSAGE_TYPE, extra: true });
    proc.emit("message", null);
    assert.equal(calls, 0);
    proc.emit("message", { type: STOP_MESSAGE_TYPE });
    assert.equal(calls, 1);
    assert.equal(proc.listenerCount("message"), 1);
    assert.equal(proc.listenerCount("disconnect"), 1);
    dispose();
    assert.equal(proc.listenerCount("message"), 0);
    assert.equal(proc.listenerCount("disconnect"), 0);
    proc.emit("message", { type: STOP_MESSAGE_TYPE });
    proc.emit("disconnect");
    assert.equal(calls, 1);
  });

  test("IPC disconnect stops; already disconnected IPC stops at registration", () => {
    const proc = fakeIpc();
    let calls = 0;
    const dispose = installCanaryReadOnlyStop(() => { calls++; }, proc);
    proc.connected = false;
    proc.emit("disconnect");
    assert.equal(calls, 1);
    dispose();
    const disconnected = fakeIpc(false);
    const disposeDisconnected = installCanaryReadOnlyStop(() => { calls++; }, disconnected);
    assert.equal(calls, 2);
    disposeDisconnected();
    assert.equal(disconnected.listenerCount("message"), 0);
    assert.equal(disconnected.listenerCount("disconnect"), 0);
  });

  test("supervised mode requires a live channel and never acknowledges a disconnected parent", () => {
    const absent = new EventEmitter();
    let calls = 0;
    installCanaryReadOnlyStop(() => { calls++; }, absent, true)();
    assert.equal(calls, 1);
    const disconnected = fakeIpc(false);
    disconnected.send = () => { throw Error("must-not-send-ready"); };
    const dispose = installCanaryReadOnlyStop(() => { calls++; }, disconnected, true);
    assert.equal(calls, 2);
    dispose();
  });

  test("supervised ready follows listener installation; stop and send failures fail closed", () => {
    const proc = fakeIpc();
    const sent = [];
    let calls = 0;
    proc.send = (message, callback) => {
      assert.equal(proc.listenerCount("message"), 1);
      assert.equal(proc.listenerCount("disconnect"), 1);
      sent.push(message);
      proc.emit("message", { type: STOP_MESSAGE_TYPE });
      callback(null);
    };
    const dispose = installCanaryReadOnlyStop(() => { calls++; }, proc, true);
    assert.deepEqual(sent, [{ type: READY_MESSAGE_TYPE }]);
    assert.equal(calls, 1);
    dispose();
    const failure = fakeIpc();
    failure.send = (_message, callback) => callback(Error("transport-failed"));
    const disposeFailure = installCanaryReadOnlyStop(() => { calls++; }, failure, true);
    assert.equal(calls, 2);
    disposeFailure();
    const throws = fakeIpc();
    throws.send = () => { throw Error("transport-failed"); };
    const disposeThrows = installCanaryReadOnlyStop(() => { calls++; }, throws, true);
    assert.equal(calls, 3);
    disposeThrows();
    const ordinary = fakeIpc();
    ordinary.send = () => { throw Error("ordinary CLI sent ready"); };
    installCanaryReadOnlyStop(() => { calls++; }, ordinary)();
    assert.equal(calls, 3);
  });

  test("without a fork IPC channel, CLI behavior remains untouched", () => {
    const proc = new EventEmitter();
    let calls = 0;
    const dispose = installCanaryReadOnlyStop(() => { calls++; }, proc);
    proc.emit("message", { type: STOP_MESSAGE_TYPE });
    proc.emit("disconnect");
    dispose();
    assert.equal(calls, 0);
    assert.equal(proc.listenerCount("message"), 0);
    assert.equal(proc.listenerCount("disconnect"), 0);
  });

  test("all three producer mains register after owning output and dispose in finally", () => {
    for (const file of ["monitor-exploit-rearm-canary.js", "monitor-rearm-canary-multichain.js", "monitor-oracle-divergence.js"]) {
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      assert.match(source, /require\(path\.join\(ROOT, "tools", "lib", "canary-readonly-stop\.js"\)\)/, file);
      assert.match(source, /const owner = acquireCanaryOutputOwner\(outPath\)[\s\S]*?const stop = \(\) => \{ stopping = true; if \(wake\) wake\(\); \};[\s\S]*?const disposeReadOnlyStop = installCanaryReadOnlyStop\(stop, process, .*?\);[\s\S]*?finally \{\s*disposeReadOnlyStop\(\);[\s\S]*?owner\.release\(\)/, file);
      assert.match(source, /if \(stopRequested\(\)\) throw new \w+ScanStopped\(\)/, file);
    }
  });

  test("real local fork cooperatively stops and releases output owner without touching history", async (t) => {
    const tempRoot = path.join(os.tmpdir(), "opencode");
    fs.mkdirSync(tempRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tempRoot, "canary-ipc-stop-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const history = path.join(dir, "history.json");
    const original = '{"runs":[{"verdict":"FIRED"}]}\n';
    fs.writeFileSync(history, original);
    const child = fork(__filename, ["--ipc-fixture", dir], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let timer;
    try {
      const ready = await Promise.race([
        once(child, "message"),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error("fixture-ready-timeout")), 5000); }),
      ]);
      clearTimeout(timer);
      assert.deepEqual(ready[0], { type: READY_MESSAGE_TYPE });
      assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), true);
      const exited = once(child, "exit");
      child.send({ type: STOP_MESSAGE_TYPE });
      const [code, signal] = await Promise.race([
        exited,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error("fixture-stop-timeout")), 5000); }),
      ]);
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
      assert.equal(fs.readFileSync(history, "utf8"), original);
      const next = acquireCanaryOutputOwner(path.join(dir, "status.json"));
      assert.equal(next.release(), true);
    } finally { clearTimeout(timer); }
  });

  test("parent disconnect before listener installation stops fixture and releases lock without ready", async (t) => {
    const tempRoot = path.join(os.tmpdir(), "opencode");
    fs.mkdirSync(tempRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tempRoot, "canary-ipc-disconnect-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const history = path.join(dir, "history.json");
    fs.writeFileSync(history, "unchanged-history\n");
    const child = fork(__filename, ["--ipc-fixture", dir, "pause-before-install"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const messages = [];
    child.on("message", (message) => { messages.push(message); });
    let timer;
    try {
      const [message] = await Promise.race([
        once(child, "message"),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error("fixture-preinstall-timeout")), 5000); }),
      ]);
      clearTimeout(timer);
      assert.deepEqual(message, { type: "preinstall" });
      assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), true);
      const exited = once(child, "exit");
      child.disconnect();
      const [code, signal] = await Promise.race([
        exited,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error("fixture-disconnect-timeout")), 5000); }),
      ]);
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.deepEqual(messages, [{ type: "preinstall" }]);
      assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
      assert.equal(fs.readFileSync(history, "utf8"), "unchanged-history\n");
    } finally { clearTimeout(timer); }
  });

  test("supervised flags reject one-shots; missing IPC exits before any scan or artifact write", (t) => {
    const tempRoot = path.join(os.tmpdir(), "opencode");
    fs.mkdirSync(tempRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tempRoot, "canary-supervised-cli-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const file of ["monitor-exploit-rearm-canary.js", "monitor-rearm-canary-multichain.js", "monitor-oracle-divergence.js"]) {
      const script = path.join(__dirname, "..", file);
      const output = path.join(dir, file, "status.json");
      const invalid = spawnSync(process.execPath, [script, "--supervised-readonly", "--out", output], { timeout: 5000 });
      assert.equal(invalid.status, 1, file);
      assert.equal(fs.existsSync(path.dirname(output)), false, file);
      const valid = spawnSync(process.execPath, [script, "--supervised-readonly", "--loop", "60", "--max-hours", "1", "--out", output], { timeout: 5000 });
      assert.equal(valid.status, 0, `${file}: ${valid.stderr}`);
      assert.equal(fs.existsSync(path.join(path.dirname(output), LOCK_NAME)), false, file);
      assert.equal(fs.existsSync(output), false, file);
      assert.equal(fs.existsSync(path.join(path.dirname(output), "history.json")), false, file);
    }
  });
}
