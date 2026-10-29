#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), child = require("node:child_process");

const ROOT = path.resolve(__dirname, ".."), NATIVE = path.join(__dirname, "native"),
  UNIT_ROOT = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\morpho-pt-post-expiry-r2-unit",
  UNIT_EXE = path.join(UNIT_ROOT, "morpho-pt-post-expiry-r2-supervisor-broker-unit.exe"),
  INVENTORY = path.join(UNIT_ROOT, "inventory.txt"),
  NORMAL = path.join(NATIVE, "morpho-pt-post-expiry-r2-supervisor-broker-win32-unit.exe"),
  DACL_FAIL = path.join(NATIVE, "morpho-pt-post-expiry-r2-supervisor-broker-win32-unit-dacl-fail.exe"),
  JOB_FAIL = path.join(NATIVE, "morpho-pt-post-expiry-r2-supervisor-broker-win32-unit-job-fail.exe"),
  UNIT_LAUNCHER = path.join(NATIVE, "morpho-pt-post-expiry-r2-launcher-linux-unit"),
  WSL_LAUNCHER = "/tmp/morpho-r2-launcher-unit";

let tests = 0, assertions = 0;
const runTest = (name, fn) => { tests++; return test(name, fn); }, a = new Proxy(assert, { get(t, k) { return typeof t[k] === "function" ? (...args) => { assertions++; return t[k](...args); } : t[k]; } });
function nonce(mode) { const b = Buffer.alloc(32); b[0] = mode; return Buffer.from(`${b.toString("hex")}\n`); }
function execute(mode, { binary = NORMAL, inventory = Buffer.from("synthetic-unit-inventory\n"), executable = UNIT_EXE, timeout = 12000 } = {}) {
  fs.copyFileSync(binary, UNIT_EXE); fs.writeFileSync(INVENTORY, inventory);
  return child.spawnSync(executable, [], { input: nonce(mode), encoding: "utf8", windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
}
function has(result, token) { return String(result.stderr).split(/\r?\n/u).includes(token); }

test.before(() => {
  fs.mkdirSync(UNIT_ROOT, { recursive: true });
  const source = UNIT_LAUNCHER.replace(/^([A-Za-z]):/u, (_, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/gu, "/");
  const installed = child.spawnSync("wsl.exe", ["--exec", "/usr/bin/install", "-m", "700", source, WSL_LAUNCHER], { windowsHide: true, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
});
test.after(() => {
  child.spawnSync("wsl.exe", ["--exec", "/usr/bin/rm", "-f", WSL_LAUNCHER], { windowsHide: true });
  try { fs.rmSync(UNIT_ROOT, { recursive: true, force: true }); } catch (_) {}
  process.stdout.write(`MORPHO_PT_POST_EXPIRY_R2_NATIVE_SUMMARY ${JSON.stringify({ tests, assertions, productionExecutions: 0, endpointInventoryReads: 0, networkRequests: 0, unitFixtureRoot: true })}\n`);
});

runTest("fragmented framed-V4 GO and DATA path retains R1G1 success marker", () => {
  const result = execute(0xaa); a.equal(result.status, 0); a.equal(has(result, "R1G1"), true); a.equal(result.stdout, "");
});
runTest("normal framed-V4 path succeeds with one GO after one unit content read", () => {
  const result = execute(0x00); a.equal(result.status, 0); a.equal(has(result, "R1G1"), true);
});
runTest("no, partial, and bad GO fail before unit content read", () => {
  for (const mode of [0xbb, 0xcc, 0xdd]) { const result = execute(mode); a.notEqual(result.status, 0); a.equal(has(result, "R0G0"), true); a.equal(has(result, "R1G1"), false); }
});
runTest("buffered, duplicate, and delayed post-GO output fail after GO without success", () => {
  for (const mode of [0xee, 0x11, 0xff]) { const result = execute(mode); a.notEqual(result.status, 0); a.match(result.stderr, /N(?:10|16|17)/u); a.match(result.stderr, /R[01]G[01]/u); }
});
runTest("nonce grammar and alternate process image fail before GO or content", () => {
  fs.copyFileSync(NORMAL, UNIT_EXE); fs.writeFileSync(INVENTORY, "synthetic\n");
  const badNonce = child.spawnSync(UNIT_EXE, [], { input: Buffer.from("z".repeat(64) + "\n"), encoding: "utf8", windowsHide: true, timeout: 6000 });
  a.notEqual(badNonce.status, 0); a.equal(has(badNonce, "N02"), true); a.equal(has(badNonce, "R0G0"), true);
  const alternate = execute(0, { executable: NORMAL }); a.notEqual(alternate.status, 0); a.equal(has(alternate, "N03"), true); a.equal(has(alternate, "R0G0"), true);
});
runTest("synthetic DACL and job failures stop before GO and content", () => {
  for (const [binary, code] of [[DACL_FAIL, "N04"], [JOB_FAIL, "N08"]]) { const result = execute(0, { binary }); a.notEqual(result.status, 0); a.equal(has(result, code), true); a.equal(has(result, "R0G0"), true); }
});
runTest("backpressure timeout kills the unit process tree without production execution", () => {
  const result = execute(0x22, { inventory: Buffer.alloc(2 * 1024 * 1024 - 1, 0x61), timeout: 12000 });
  a.notEqual(result.status, 0); a.equal(has(result, "N14") || has(result, "N15"), true); a.equal(has(result, "R1G1"), true); a.equal(result.error?.code === "ETIMEDOUT", false);
  const orphan = child.spawnSync("wsl.exe", ["--exec", "/usr/bin/pgrep", "-f", `^${WSL_LAUNCHER}$`], { windowsHide: true, encoding: "utf8" });
  a.notEqual(orphan.status, 0);
});
runTest("qualified production runtime authority requires an external permit and remains unexecuted", () => {
  const policy = require("./morpho-pt-27aug2026-post-expiry-r2-production-policy.js").POLICY,
    capture = require("./capture-morpho-pt-27aug2026-post-expiry-r2-production.js");
  a.equal(policy.input.nativeStage, "RUNTIME_COPIES_QUALIFIED"); a.equal(policy.input.nativeStaged, true); a.equal(policy.input.nativeBlocker, "NATIVE_R2_PERMIT_REQUIRED");
  a.equal(policy.input.nativeSupervisorSha256, "d6e09832bf9e01ac7539472fa22ab22bbfc8a54cfd85f432ce20c4467494fa7e");
  a.equal(policy.input.nativeLauncherSha256, "6d8e7651d21f223e60de3dfbef101f00ff60d3d7f78fe0ef290fdca0e6d3c645");
  a.equal(policy.input.nodeExecutableSha256, "53fb205ae78805130177e24bcb459a69a1518c8d98f8965f31d85aae7ea840fc");
  a.match(policy.input.nodePath, /post-expiry-r2\/runtime\/bin\/node$/u); a.match(policy.input.launcherPath, /post-expiry-r2-launcher-linux$/u);
  a.match(policy.input.capturePath, /post-expiry-r2\/tools\/capture-morpho-pt-27aug2026-post-expiry-r2-production\.js$/u);
  a.equal(typeof capture.validateNativeManifest, "function"); a.equal(typeof capture.bindings, "function");
});
