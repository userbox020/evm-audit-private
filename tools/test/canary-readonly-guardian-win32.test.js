"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomBytes } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const compiler = "C:\\TDM-GCC-64\\bin\\x86_64-w64-mingw32-gcc.exe";
const root = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode";
const source = path.join(__dirname, "..", "native", "canary-readonly-guardian-win32.c");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

if (process.platform !== "win32") {
  test("Windows guardian offline fixtures", { skip: "Windows only" }, () => {});
} else {
  const workspace = fs.mkdtempSync(path.join(root, "canary-readonly-guardian-unit-"));
  const exe = path.join(workspace, "guardian.exe");
  const faultExe = path.join(workspace, "guardian-fault.exe");
  const releaseExe = path.join(workspace, "guardian-production-not-run.exe");
  const compile = (target, fault) => {
    const build = spawnSync(compiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-municode", "-O2",
      "-DCANARY_GUARDIAN_UNIT=1", "-DCANARY_GUARDIAN_TEST_SECONDS=8",
      ...(fault ? ["-DCANARY_GUARDIAN_FAIL_ASSIGN=1"] : []), source, "-o", target, "-lbcrypt"],
    { encoding: "utf8", timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
  };
  const setup = (mode) => {
    const dir = fs.mkdtempSync(path.join(workspace, "case-"));
    const baseline = path.join(dir, "baseline.txt"); fs.writeFileSync(baseline, mode);
    const paths = ["dedicated", "multichain", "divergence", "wrapper"].map((name) => {
      const item = path.join(dir, name); fs.mkdirSync(item); return item;
    });
    return { dir, args: [baseline, ...paths], wrapper: paths[3] };
  };
  const launch = (target, args) => {
    const child = spawn(target, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.completion = new Promise((resolve, reject) => {
      let stdout = "", stderr = "";
      child.stdout.on("data", (bytes) => { stdout += bytes; });
      child.stderr.on("data", (bytes) => { stderr += bytes; });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    return child;
  };
  const finish = (child, timeout = 14000) => new Promise((resolve, reject) => {
    const alarm = setTimeout(() => { child.kill(); reject(new Error("guardian hung")); }, timeout);
    child.completion.then((outcome) => { clearTimeout(alarm); resolve(outcome); },
      (error) => { clearTimeout(alarm); reject(error); });
  });
  const waitFor = async (file, child) => {
    for (let i = 0; i < 150; i++) { if (fs.existsSync(file)) return Number(fs.readFileSync(file, "utf8")); await delay(20); }
    const completed = child ? await Promise.race([child.completion, delay(100).then(() => null)]) : null;
    const trace = path.join(workspace, "guardian-unit-trace.txt");
    const stages = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").slice(-8).join("; ") : "none";
    throw new Error(`offline child failed to start; verify=${fs.existsSync(path.join(path.dirname(file), "fixture-verify-status.txt")) ? fs.readFileSync(path.join(path.dirname(file), "fixture-verify-status.txt"), "utf8") : "not reached"}; guardian=${completed?.code} ${completed?.stderr}; numeric stages=${stages}`);
  };
  const stopped = async (pids) => {
    for (let i = 0; i < 100 && pids.some(alive); i++) await delay(30);
    for (const pid of pids) assert.equal(alive(pid), false, `PID ${pid} persisted`);
  };

  test("compile release and fixture-only binaries; reject injected path and assignment failure", () => {
    compile(exe, false); compile(faultExe, true);
    const release = spawnSync(compiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-municode",
      "-O2", source, "-o", releaseExe, "-lbcrypt"], { encoding: "utf8", timeout: 30000 });
    assert.equal(release.status, 0, release.stderr); // Never run the production build here.
    const fixture = setup("await");
    let run = spawnSync(exe, [fixture.args[0] + '" --inspect', ...fixture.args.slice(1)],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 1);
    assert.equal(fs.existsSync(path.join(fixture.wrapper, "fixture-owner.lock")), false);
    run = spawnSync(faultExe, fixture.args, { encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 1);
    assert.equal(fs.existsSync(path.join(fixture.wrapper, "fixture-owner.lock")), false);
    assert.equal(spawnSync(exe, [fixture.args[0], fixture.args[1], fixture.args[1], ...fixture.args.slice(3)],
      { encoding: "utf8", timeout: 5000 }).status, 1);
    const forgedName = `\\\\.\\pipe\\canary-readonly-guardian-v2-${randomBytes(16).toString("hex")}`;
    const direct = spawnSync("C:\\Program Files\\nodejs\\node.exe",
      [path.join(__dirname, "fixtures", "canary-readonly-guardian-child.js"), "--run-readonly",
        "--baseline", fixture.args[0], "--wrapper-dir", fixture.wrapper],
      { encoding: "utf8", input: `CANARY_READONLY_GUARDIAN_V2 ${forgedName}\n`, timeout: 5000 });
    assert.equal(direct.status, 4); // No stdin handoff => no lock or descendants.
    assert.equal(fs.existsSync(path.join(fixture.wrapper, "fixture-owner.lock")), false);
    assert.notEqual(spawnSync(exe, ["--verify", forgedName], { encoding: "utf8", timeout: 5000 }).status, 0);
  });

  test("wrong named-pipe server cannot attest", async () => {
    const name = `\\\\.\\pipe\\canary-readonly-guardian-v2-${randomBytes(16).toString("hex")}`;
    let accepted = 0;
    const server = net.createServer((socket) => {
      accepted++;socket.on("error", () => {});socket.write("1");socket.end();
    });
    await new Promise((resolve, reject) => server.listen(name, (error) => error ? reject(error) : resolve()));
    try {
      const verdict = await finish(launch(exe, ["--verify", name]));
      assert.notEqual(verdict.code, 0);
      assert.ok(accepted >= 1, "untrusted server was reached but could not attest");
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  for (const mode of ["verifier-stall", "verifier-exit"]) {
    test(`${mode} fails closed without removing stale lock`, async () => {
      const fixture = setup(mode);
      const lock = path.join(fixture.wrapper, "fixture-owner.lock");
      fs.writeFileSync(lock, "stale-owned");
      const start = Date.now();
      const child = launch(exe, fixture.args);
      const pid = await waitFor(path.join(fixture.wrapper, "preverify.pid"), child);
      if (mode === "verifier-stall") {
        await delay(Math.max(0, start + 10500 - Date.now()));
        assert.equal(alive(pid), false, "child survived the 8s hard deadline plus bounded cleanup");
      }
      const result = await finish(child);
      assert.notEqual(result.code, 0);
      await stopped([pid]);
      assert.equal(fs.readFileSync(lock, "utf8"), "stale-owned");
      assert.equal(fs.existsSync(path.join(fixture.wrapper, "verified.txt")), false);
    });
  }

  test("attested fixture error reports only its numeric exit code", async () => {
    const fixture = setup("error"); // The fixed fixture's unknown-mode branch exits 6.
    const outcome = await finish(launch(exe, fixture.args));
    assert.equal(outcome.code, 3);
    assert.equal(outcome.stdout, "GUARDIAN_ATTESTED\n");
    assert.equal(outcome.stderr, "GUARDIAN_CHILD_EXIT 6\n");
    assert.equal(fs.readFileSync(path.join(fixture.wrapper, "verified.txt"), "utf8"), "yes");
    assert.equal(fs.existsSync(path.join(fixture.wrapper, "fixture-owner.lock")), true);
    const descendants = path.join(fixture.wrapper, "descendant.pid");
    if (fs.existsSync(descendants)) await stopped([Number(fs.readFileSync(descendants, "utf8"))]);
  });

  for (const mode of ["await", "busy", "normal", "hard-exit", "pause"]) {
    test(`job removes child and descendant on ${mode}; stale lock not stolen`, async () => {
      const fixture = setup(mode);
      const child = launch(exe, fixture.args);
      const childPid = await waitFor(path.join(fixture.wrapper, "child.pid"), child);
      const descendantPid = await waitFor(path.join(fixture.wrapper, "descendant.pid"));
      assert.equal(fs.readFileSync(path.join(fixture.wrapper, "verified.txt"), "utf8"), "yes");
      if (mode === "hard-exit") child.kill("SIGKILL");
      const outcome = await finish(child);
      if (mode === "normal") {
        assert.equal(outcome.code, 3);
        assert.equal(outcome.stdout, "GUARDIAN_ATTESTED\n");
        assert.equal(outcome.stderr, "GUARDIAN_CHILD_EXIT 0\n");
      }
      else if (mode !== "hard-exit") assert.equal(outcome.code, 2);
      await stopped([childPid, descendantPid]);
      assert.equal(fs.existsSync(path.join(fixture.wrapper, "fixture-owner.lock")), true);
      if (mode === "normal") assert.notEqual(fs.readFileSync(path.join(fixture.wrapper, "duplicate.status"), "utf8"), "0");
      const retry = spawnSync(exe, fixture.args, { encoding: "utf8", timeout: 5000 });
      assert.equal(retry.status, 3, `stale lock retry: ${retry.stdout} ${retry.stderr}`);
      assert.equal(retry.stderr, "GUARDIAN_CHILD_EXIT 5\n");
      assert.equal(fs.existsSync(path.join(fixture.wrapper, "fixture-owner.lock")), true);
    });
  }

  test.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); });
}
