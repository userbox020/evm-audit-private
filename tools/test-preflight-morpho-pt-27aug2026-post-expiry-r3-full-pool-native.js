#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const child = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const NATIVE = path.join(__dirname, "native");
const UNIT_ROOT = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\morpho-pt-post-expiry-r3-preflight-unit";
const PRODUCTION_RUNNER = "C:\\_Work\\__EVM_AUDIT\\.runtime\\morpho-pt-post-expiry-r3-preflight\\morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32.exe";
const OLD_PRODUCTION_RUNNER = "C:\\_Work\\__EVM_AUDIT\\.runtime\\morpho-pt-post-expiry-r2\\morpho-pt-post-expiry-r2-full-pool-preflight-runner-win32.exe";
const UNIT_EXE = path.join(UNIT_ROOT, "morpho-pt-post-expiry-r3-full-pool-preflight-runner-unit.exe");
const INVENTORY = path.join(UNIT_ROOT, "inventory-fixture.txt");
const SOURCE = path.join(UNIT_ROOT, "source-fixture.js");
const LINUX_LAUNCHER = "/tmp/morpho-r3-preflight-launcher-unit";
const LINUX_SOURCE = "/tmp/morpho-r3-preflight-source-unit.js";
const RUNNERS = Object.freeze({
  normal: path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit.exe"),
  dacl: path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-dacl-fail.exe"),
  job: path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-job-fail.exe"),
  badTarget: path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-bad-target.exe"),
  extra: path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-extra.exe"),
  hang: path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-hang.exe"),
  postcheck: path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-postcheck-fail.exe"),
});
const LAUNCHERS = Object.freeze({
  normal: path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux-unit"),
  extra: path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux-unit-extra"),
  hang: path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux-unit-hang"),
});
const SOURCE_BYTES = Buffer.from("// synthetic preflight authority fixture; no endpoint data\n", "utf8");
const INVENTORY_BYTES = Buffer.from("synthetic-unit-inventory-content-must-never-be-read\n", "utf8");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const linux = (file) => file.replace(/^([A-Za-z]):/u, (_, drive) => `/mnt/${drive.toLowerCase()}`).replace(/\\/gu, "/");
const WSL_USER = ["-d", "Ubuntu-22.04", "--user", "mruserbox", "--exec"];
const WINDOWS_VARIANTS = Object.freeze([
  ["normal", "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit.exe", ["-DUNIT_TEST", "-Wno-unused-function"]],
  ["dacl", "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-dacl-fail.exe", ["-DUNIT_TEST", "-DUNIT_DACL_FAILURE", "-Wno-unused-function"]],
  ["job", "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-job-fail.exe", ["-DUNIT_TEST", "-DUNIT_JOB_FAILURE", "-Wno-unused-function"]],
  ["badTarget", "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-bad-target.exe", ["-DUNIT_TEST", "-DUNIT_BAD_TARGET_HASH", "-Wno-unused-function"]],
  ["extra", "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-extra.exe", ["-DUNIT_TEST", "-DUNIT_EXTRA_LAUNCHER", "-Wno-unused-function"]],
  ["hang", "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-hang.exe", ["-DUNIT_TEST", "-DUNIT_HANG_LAUNCHER", "-Wno-unused-function"]],
  ["postcheck", "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32-unit-postcheck-fail.exe", ["-DUNIT_TEST", "-DUNIT_POSTCHECK_FAILURE", "-Wno-unused-function"]],
]);
const LINUX_VARIANTS = Object.freeze([
  ["normal", "morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux-unit", ["-DUNIT_TEST", "-Wno-unused-function", "-Wno-unused-const-variable"]],
  ["extra", "morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux-unit-extra", ["-DUNIT_TEST", "-DUNIT_EXTRA_OUTPUT", "-Wno-unused-function", "-Wno-unused-const-variable"]],
  ["hang", "morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux-unit-hang", ["-DUNIT_TEST", "-DUNIT_HANG", "-Wno-unused-function", "-Wno-unused-const-variable"]],
]);
function validateManifest() {
  const manifestPath = path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-native-build-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const preflight = require("./preflight-morpho-pt-27aug2026-post-expiry-r3-full-pool.js");
  assert.equal(manifest.stage, "WORKSPACE_LOCAL_AUTHORITY_PACKAGE_BUILT_NOT_STAGED");
  assert.equal(manifest.productionExecution, false);
  assert.equal(manifest.productionStaging, false);
  assert.equal(manifest.inventoryContentRead, false);
  assert.equal(manifest.windows.buildCount, 2);
  assert.equal(manifest.windows.byteIdentical, true);
  assert.equal(manifest.linux.buildCount, 2);
  assert.equal(manifest.linux.byteIdentical, true);
  const assertCommands = (row) => {
    assert.equal(row.command.filter((arg) => arg === "-o").length, 1);
    assert.equal(row.command.filter((arg) => arg === "<output>").length, 1);
    assert.equal(row.compileCommands.length, 2);
    for (let index = 0; index < row.compileCommands.length; index++) {
      const command = row.compileCommands[index];
      assert.equal(command.filter((arg) => arg === "-o").length, 1);
      assert.equal(command.includes("<output>"), false);
      const output = command[command.indexOf("-o") + 1];
      assert.equal(output.replace(/^\/mnt\/c\/_Work\/__EVM_AUDIT\//u, ""), row.buildOutputs[index]);
      assert.deepEqual(row.command.map((arg) => arg === "<output>" ? output : arg), command);
    }
  };
  assert.equal(sha256(fs.readFileSync(manifest.windows.compilerExecutable)), manifest.windows.compilerExecutableSha256);
  const linuxCompiler = child.spawnSync("wsl.exe", [...WSL_USER, "/usr/bin/sha256sum", manifest.linux.compilerExecutable], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(linuxCompiler.status, 0, linuxCompiler.stderr);
  assert.equal(linuxCompiler.stdout.slice(0, 64), manifest.linux.compilerExecutableSha256);
  for (const platform of ["windows", "linux"]) {
    const row = manifest[platform];
    assert.equal(row.command[0], row.compilerExecutable);
    assert.equal(row.buildOutputs.length, 2);
    assert.deepEqual(row.buildSha256, [row.binarySha256, row.binarySha256]);
    assert.deepEqual(row.buildOutputs.map((file) => sha256(fs.readFileSync(path.join(__dirname, "..", file)))), row.buildSha256);
    assertCommands(row);
  }
  assert.equal(sha256(fs.readFileSync(path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32.c"))), manifest.windows.sourceSha256);
  assert.equal(sha256(fs.readFileSync(path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32.exe"))), manifest.windows.binarySha256);
  assert.equal(sha256(fs.readFileSync(path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux.c"))), manifest.linux.sourceSha256);
  assert.equal(sha256(fs.readFileSync(path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux"))), manifest.linux.binarySha256);
  for (const [platform, expected] of [["windows", WINDOWS_VARIANTS], ["linux", LINUX_VARIANTS]]) {
    assert.equal(manifest[platform].unitVariants.length, expected.length);
    for (let index = 0; index < expected.length; index++) {
      const [name, filename, macros] = expected[index], row = manifest[platform].unitVariants[index];
      assert.equal(row.name, name);
      assert.equal(row.path, `tools/native/${filename}`);
      for (const macro of macros) assert.equal(row.macros.includes(macro), true);
      if (platform === "windows") assert.equal(row.macros.some((macro) => /^-DEXPECTED_LAUNCHER_SHA256="[0-9a-f]{64}"$/u.test(macro)), true);
      assert.equal(row.buildCount, 2);
      assert.equal(row.byteIdentical, true);
      assert.equal(sha256(fs.readFileSync(path.join(NATIVE, filename))), row.binarySha256);
      assert.equal(row.command[0], manifest[platform].compilerExecutable);
      assert.equal(row.buildOutputs.length, 2);
      assert.deepEqual(row.buildSha256, [row.binarySha256, row.binarySha256]);
      assert.deepEqual(row.buildOutputs.map((file) => sha256(fs.readFileSync(path.join(__dirname, "..", file)))), row.buildSha256);
      assertCommands(row);
    }
  }
  assert.equal(preflight.RUNNER_SHA256, manifest.windows.binarySha256);
  assert.equal(preflight.RUNNER, PRODUCTION_RUNNER);
  assert.notEqual(preflight.RUNNER, OLD_PRODUCTION_RUNNER);
  assert.equal(manifest.windows.fixedProductionPath, PRODUCTION_RUNNER);
  assert.equal(preflight.LAUNCHER_SHA256, manifest.linux.binarySha256);
  assert.equal(sha256(fs.readFileSync(path.join(__dirname, "preflight-morpho-pt-27aug2026-post-expiry-r3-full-pool.js"))), manifest.bindings.preflightSourceSha256);
  assert.equal(sha256(fs.readFileSync(path.join(__dirname, "test-preflight-morpho-pt-27aug2026-post-expiry-r3-full-pool.js"))), manifest.bindings.preflightTestSha256);
  assert.equal(sha256(fs.readFileSync(__filename)), manifest.bindings.nativeUnitTestSha256);
  assert.deepEqual([...new Set(JSON.stringify(manifest).match(/<[^>]+>/gu) || [])], ["<output>"]);
  assert.deepEqual(manifest.blockers, ["PREFLIGHT_RUNTIME_DIRECTORY_NOT_CREATED", "PRODUCTION_RUNTIME_NOT_STAGED", "PRODUCTION_ACL_NOT_APPLIED", "ACTUAL_INVENTORY_NOT_QUALIFIED", "PREFLIGHT_NOT_EXECUTED", "PERMIT_NOT_ISSUED", "CAPTURE_NOT_EXECUTED"]);
  return manifest;
}
function install(launcher = LAUNCHERS.normal) {
  const result = child.spawnSync("wsl.exe", [...WSL_USER, "/usr/bin/install", "-m", "700", linux(launcher), LINUX_LAUNCHER], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
}
function prepare(runner = RUNNERS.normal, launcher = LAUNCHERS.normal) { fs.copyFileSync(runner, UNIT_EXE); install(launcher); }
function execute(runner = RUNNERS.normal, launcher = LAUNCHERS.normal, options = {}) {
  prepare(runner, launcher);
  const before = { inventory: sha256(fs.readFileSync(INVENTORY)), source: sha256(fs.readFileSync(SOURCE)) };
  const result = child.spawnSync(UNIT_EXE, options.args || [], { input: options.input === undefined ? Buffer.alloc(0) : options.input, encoding: "utf8", windowsHide: true, timeout: options.timeout || 10000, maxBuffer: 64 * 1024, env: options.env || process.env });
  assert.equal(sha256(fs.readFileSync(INVENTORY)), before.inventory);
  assert.equal(sha256(fs.readFileSync(SOURCE)), before.source);
  return result;
}
function has(result, code) { return String(result.stderr).split(/\r?\n/u).includes(code); }

test.before(() => {
  validateManifest();
  fs.mkdirSync(UNIT_ROOT, { recursive: true });
  fs.writeFileSync(INVENTORY, INVENTORY_BYTES);
  fs.writeFileSync(SOURCE, SOURCE_BYTES);
  const installed = child.spawnSync("wsl.exe", [...WSL_USER, "/usr/bin/install", "-m", "600", linux(SOURCE), LINUX_SOURCE], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(installed.status, 0, installed.stderr);
});
test.after(() => {
  child.spawnSync("wsl.exe", [...WSL_USER, "/usr/bin/rm", "-f", LINUX_LAUNCHER, LINUX_SOURCE], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  try { fs.rmSync(UNIT_ROOT, { recursive: true, force: true }); } catch (_) {}
  process.stdout.write(`${JSON.stringify({ suite: "R3_FULL_POOL_PREFLIGHT_NATIVE_UNIT", productionExecutions: 0, productionStaging: 0, endpointInventoryReads: 0, networkRequests: 0 })}\n`);
});

test("UNIT runner closes native authority and emits only validated preflight JSON", () => {
  const result = execute();
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "POOL_READY");
  assert.equal(parsed.slots.length, 8);
  assert.deepEqual(parsed.selectedPoolIndices, [0, 1, 2]);
  assert.deepEqual(parsed.aggregate, { requests: 17, responseBytes: 1024, maxConcurrency: 1, retries: 0 });
  assert.equal(has(result, "UNIT_I0"), true);
  assert.doesNotMatch(result.stdout, /(?:https?|wss):\/\/|endpoint|family|header|sha256|stack|rawError/iu);
});

test("alternate image, arguments, and stdin injection fail before child launch", () => {
  install();
  const alternate = child.spawnSync(RUNNERS.normal, [], { input: Buffer.alloc(0), encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.notEqual(alternate.status, 0);
  assert.equal(has(alternate, "PFR01"), true);
  for (const options of [{ args: ["extra"] }, { input: Buffer.from("injected") }]) {
    const result = execute(RUNNERS.normal, LAUNCHERS.normal, options);
    assert.notEqual(result.status, 0);
    assert.equal(has(result, "PFR01"), true);
  }
});

test("closed empty stdin is accepted while trailing and held-open stdin reject immediately", async () => {
  assert.equal(execute().status, 0);
  assert.equal(execute(RUNNERS.normal, LAUNCHERS.normal, { input: Buffer.from("trailing") }).status, 2);
  prepare();
  const started = Date.now(), process = child.spawn(UNIT_EXE, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = ""; process.stderr.setEncoding("utf8"); process.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { process.kill(); reject(new Error("held-open stdin did not reject")); }, 1500); process.on("exit", (value) => { clearTimeout(timer); resolve(value); }); });
  assert.equal(code, 2);
  assert.match(stderr, /PFR01/u);
  assert.ok(Date.now() - started < 1500);
});

test("explicit UID/GID authority rejects root UNIT launcher execution", () => {
  install();
  const result = child.spawnSync("wsl.exe", ["-d", "Ubuntu-22.04", "--user", "root", "--exec", LINUX_LAUNCHER], { input: Buffer.alloc(0), encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PFL01/u);
});

test("DACL and assignment-before-resume job failures stop without output", () => {
  for (const [runner, code] of [[RUNNERS.dacl, "PFR02"], [RUNNERS.job, "PFR09"]]) {
    const result = execute(runner);
    assert.notEqual(result.status, 0);
    assert.equal(has(result, code), true);
    assert.equal(result.stdout, "");
    assert.equal(has(result, "UNIT_I0"), true);
  }
});

test("wrong target and launcher hashes reject before synthetic output", () => {
  const badTarget = execute(RUNNERS.badTarget);
  assert.notEqual(badTarget.status, 0);
  assert.equal(badTarget.stdout, "");
  assert.match(badTarget.stderr, /PFR13|PFL3[45]/u);
  const badLauncher = execute(RUNNERS.normal, LAUNCHERS.extra);
  assert.notEqual(badLauncher.status, 0);
  assert.equal(badLauncher.stdout, "");
  assert.match(badLauncher.stderr, /PFR13|PFL34/u);
});

test("extra or delayed stdout is rejected and never forwarded", () => {
  const result = execute(RUNNERS.extra, LAUNCHERS.extra);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(has(result, "PFR13"), true);
});

test("timeout kills the WSL process tree", () => {
  const result = execute(RUNNERS.hang, LAUNCHERS.hang, { timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.equal(result.error?.code === "ETIMEDOUT", false);
  assert.equal(result.stdout, "");
  const orphan = child.spawnSync("wsl.exe", [...WSL_USER, "/usr/bin/pgrep", "-f", `^${LINUX_LAUNCHER}$`], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.notEqual(orphan.status, 0);
});

test("inventory guard denies write/delete/rename while held and child succeeds unchanged", async () => {
  prepare();
  const before = sha256(fs.readFileSync(INVENTORY)), replacement = `${INVENTORY}.replacement`;
  const process = child.spawn(UNIT_EXE, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); process.stdin.end();
  let stderr = ""; process.stderr.setEncoding("utf8");
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`inventory hold not reached: ${stderr}`)), 2000); process.stderr.on("data", (data) => { stderr += data; if (stderr.includes("UNIT_INV_HELD")) { clearTimeout(timer); resolve(); } }); });
  assert.equal(process.exitCode, null, stderr);
  const sharingViolation = (operation) => assert.throws(operation, (error) => error.code === "EBUSY");
  const denied = (operation) => assert.throws(operation, (error) => ["EBUSY", "EPERM", "EACCES"].includes(error.code));
  sharingViolation(() => fs.openSync(INVENTORY, "a"));
  sharingViolation(() => fs.openSync(INVENTORY, "r+"));
  denied(() => fs.unlinkSync(INVENTORY));
  denied(() => fs.renameSync(INVENTORY, replacement));
  assert.equal(sha256(fs.readFileSync(INVENTORY)), before);
  assert.equal(fs.existsSync(replacement), false);
  const code = await new Promise((resolve) => process.on("exit", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(sha256(fs.readFileSync(INVENTORY)), sha256(INVENTORY_BYTES));
});

test("forced post-child identity/ACL failure returns PFR15 without fixture mutation", () => {
  const before = sha256(fs.readFileSync(INVENTORY)), result = execute(RUNNERS.postcheck);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(has(result, "PFR15"), true);
  assert.equal(has(result, "UNIT_I0"), true);
  assert.equal(sha256(fs.readFileSync(INVENTORY)), before);
});

test("source fixes restricted handles, exact command/env, and non-reading inventory guard", () => {
  const windows = fs.readFileSync(path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32.c"), "utf8");
  const launcher = fs.readFileSync(path.join(NATIVE, "morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux.c"), "utf8");
  assert.match(windows, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/u);
  assert.match(windows, /CREATE_SUSPENDED/u);
  assert.match(windows, /AssignProcessToJobObject\(job,pi\.hProcess\)\|\|ResumeThread/u);
  assert.match(windows, /CreateFileW\(INVENTORY_PATH,FILE_READ_ATTRIBUTES\|READ_CONTROL/u);
  assert.doesNotMatch(windows, /CreateFileW\(INVENTORY_PATH,GENERIC_READ/u);
  const guardOpen = windows.indexOf("inventoryGuard=CreateFileW(INVENTORY_PATH,FILE_READ_DATA|SYNCHRONIZE,FILE_SHARE_READ,NULL,OPEN_EXISTING");
  const outputAcceptance = windows.indexOf("bounded_write(GetStdHandle(STD_OUTPUT_HANDLE)");
  const guardClose = windows.indexOf("wsl,target,inventoryGuard,inventory,dir,self");
  assert.ok(guardOpen >= 0);
  assert.doesNotMatch(windows, /CreateFileW\(INVENTORY_PATH,[^;]*(?:FILE_SHARE_WRITE|FILE_SHARE_DELETE)/u);
  assert.ok(guardOpen < outputAcceptance && outputAcceptance < guardClose);
  assert.doesNotMatch(windows, /ReadFile\(inventory(?:Guard)?/u);
  assert.match(windows, /same_id\(&inventoryBefore,&inventoryAfter\)&&acl_secure\(inventory\)/u);
  assert.match(windows, /--user mruserbox/u);
  assert.match(windows, /morpho-pt-post-expiry-r3-preflight/u);
  assert.doesNotMatch(windows, /morpho-pt-post-expiry-r2-full-pool-preflight-runner-win32\.exe/u);
  assert.match(launcher, /morpho-pt-post-expiry-r3-preflight/u);
  assert.doesNotMatch(launcher, /morpho-pt-post-expiry-r2-full-pool-preflight-runner-win32\.exe/u);
  assert.doesNotMatch(windows, /stdin_empty[\s\S]*ReadFile\(h,/u);
  assert.match(windows, /SystemRoot=C:\\\\Windows\\0WINDIR=C:\\\\Windows/u);
  assert.match(windows, /C:\\\\Windows\\\\System32\\\\wsl\.exe/u);
  assert.match(launcher, /dup2\(pipefd\[0\],3\)/u);
  assert.match(launcher, /getuid\(\)!=1000\|\|geteuid\(\)!=1000\|\|getgid\(\)!=1000\|\|getegid\(\)!=1000/u);
  assert.match(launcher, /LANG=C\.UTF-8.*LC_ALL=C\.UTF-8.*TZ=UTC/u);
  assert.match(launcher, /char\*const av\[\]=\{\(char\*\)NODE_PATH,\(char\*\)TARGET_PATH,\(char\*\)FLAG,NULL\}/u);
});

test("deterministic manifest binds both compilers, sources, binaries, and unstaged blockers", () => {
  const manifest = validateManifest();
  assert.equal(manifest.windows.unitVariants.length, 7);
  assert.equal(manifest.linux.unitVariants.length, 3);
});
