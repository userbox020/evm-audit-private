#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const diagnostic = require("./diagnose-morpho-pt-27aug2026-post-expiry-r4-pre-go.js");
const validator = require("./validate-diagnose-morpho-pt-27aug2026-post-expiry-r4-pre-go.js");

const TEMP_PARENT = path.join(os.tmpdir(), "opencode");
const childSafety = (permitReads = 1) => ({ ...diagnostic.ZERO_SAFETY, productionNodeDiagnosticExecutions: 1, productionPermitReads: permitReads, wslChildExecutions: 1, powershellChildExecutions: 2, containedChildExecutions: 1, childTreeCleanupConfirmations: 1 });
const pass = (permitState = "expired", permitReads = 1) => ({ p01: true, p02: true, p03: true, p04: true, p05Structure: true, p05PolicyTools: true, p05RuntimeBridge: true, p05Time: true, permitState, p06: true, p07: true, p10: true, safety: childSafety(permitReads) });
const phase = (ok = true, mutationOperations = 0, cleanupOperations = 0) => ({ ok, mutationOperations, cleanupOperations });
const synthetic = (durability = true, lock = true) => ({ durability: () => phase(durability, 4, 1), lock: () => phase(lock, 3, 1) });
const clone = (value) => JSON.parse(JSON.stringify(value));
const linuxPass = (permitState = "expired", permitReads = 1) => ({ p01: true, p02: true, p05Structure: permitReads === 1, p05PolicyTools: permitReads === 1, p05RuntimeBridge: permitReads === 1, p05Time: permitReads === 1, p06: true, p07: true, permitState, permitReads });
function protocol(stdout, overrides = {}) {
  const value = { kind: "EXIT", exitCode: 0, stdoutBase64: Buffer.from(typeof stdout === "string" ? stdout : JSON.stringify(stdout)).toString("base64"), stderrBase64: "", treeTerminated: true, childPid: 123, sideEffectPathBase64: "", processExited: true, jobActiveProcesses: 0, ...overrides };
  return { status: 0, signal: null, error: undefined, stdout: JSON.stringify(value), stderr: "" };
}
function routedSpawn(linux = linuxPass(), acl = { ok: true }, calls = []) {
  return (file, args, options) => {
    calls.push({ file, args, options }); const mode = args[7];
    if (mode === "WSL_PROBE") return protocol(linux);
    if (mode === "ACL_PROBE") return protocol(acl);
    throw new Error("UNEXPECTED_MODE");
  };
}

test("finite sanitized expired result validates independently with truthful counters", () => {
  const result = diagnostic.classify({ snapshot: pass(), synthetic: synthetic() });
  assert.equal(result.overall, "BLOCKED_EXPIRED"); assert.deepEqual(result.safety, { ...childSafety(), syntheticMutationOperations: 7, syntheticCleanupOperations: 2 });
  assert.deepEqual(validator.validate(clone(result)), result); assert.doesNotMatch(diagnostic.canonical(result), /[a-z]:\\|\/(?:home|mnt|tmp)\/|\b[0-9a-f]{64}\b|permitId|commitment|endpoint/iu);
});

test("absent retained active permit is explicit and never falls back to archive", () => {
  const result = diagnostic.classify({ snapshot: pass("absent", 0), synthetic: synthetic() });
  assert.equal(result.phases.P05, "P05_ACTIVE_PERMIT_ABSENT"); assert.equal(result.overall, "BLOCKED_ACTIVE_PERMIT_ABSENT"); validator.validate(clone(result));
  const source = diagnostic.linuxProbeSource(); assert.doesNotMatch(source, /\.expired\.json|archive(?:d)?Permit|fallbackPermit/iu); assert.match(source, /ACTIVE=R\+"\/permits\/morpho-pt-27aug2026-post-expiry-r2-production\.json"/u);
});

test("current permit changes only finite P05 and overall", () => {
  const result = diagnostic.classify({ snapshot: pass("current"), synthetic: synthetic() }); assert.equal(result.phases.P05, "P05_PASS_CURRENT_NONCE_UNAVAILABLE"); assert.equal(result.overall, "PASS_LIMITED"); validator.validate(clone(result));
});

test("every P01-P10 fault maps to its own finite failure", () => {
  for (const [key, field] of [["P01", "p01"], ["P02", "p02"], ["P03", "p03"], ["P04", "p04"], ["P06", "p06"], ["P07", "p07"], ["P10", "p10"]]) { const snapshot = pass(); snapshot[field] = false; const result = diagnostic.classify({ snapshot, synthetic: synthetic() }); assert.equal(result.phases[key], `${key}_FAIL`); assert.equal(result.overall, "FAIL"); }
  assert.equal(diagnostic.classify({ snapshot: pass(), synthetic: synthetic(false, true) }).phases.P08, "P08_FAIL"); assert.equal(diagnostic.classify({ snapshot: pass(), synthetic: synthetic(true, false) }).phases.P09, "P09_FAIL");
});

test("split active-permit authority faults fail P05", () => {
  for (const field of ["p05Structure", "p05PolicyTools", "p05RuntimeBridge", "p05Time"]) { const snapshot = pass(); snapshot[field] = false; assert.equal(diagnostic.classify({ snapshot, synthetic: synthetic() }).phases.P05, "P05_FAIL"); }
  for (const state of ["invalid", "not-yet-valid"]) { const snapshot = pass(state); assert.equal(diagnostic.classify({ snapshot, synthetic: synthetic() }).phases.P05, "P05_FAIL"); }
});

test("probeLinux uses pinned absolute contained PowerShell and exact request", () => {
  const calls = [], result = diagnostic.probeLinux({ spawnSync: routedSpawn(linuxPass(), { ok: true }, calls) }); assert.deepEqual(result.data, linuxPass()); assert.equal(calls.length, 1);
  const call = calls[0]; assert.equal(call.file, diagnostic.POWERSHELL); assert.equal(path.isAbsolute(call.file), true); assert.deepEqual(call.args.slice(0, 9), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", diagnostic.CONTAINED_HELPER, "-Mode", "WSL_PROBE", "-PayloadBase64"]); assert.equal(call.args.length, 10);
  assert.deepEqual(call.options, { shell: false, windowsHide: true, encoding: "utf8", timeout: 35000, maxBuffer: 4096, env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" } });
  const source = Buffer.from(call.args[9], "base64").toString("utf8"); assert.equal(source, diagnostic.linuxProbeSource()); assert.doesNotMatch(source, /\.expired\.json/u);
});

test("probeWindowsAcl uses exact bounded helper and strict ACL/handle authority program", () => {
  const calls = [], result = diagnostic.probeWindowsAcl({ spawnSync: routedSpawn(linuxPass(), { ok: true }, calls) }); assert.equal(result.ok, true); assert.equal(calls.length, 1); assert.equal(calls[0].args[7], "ACL_PROBE"); assert.equal(calls[0].args.length, 8);
  const source = fs.readFileSync(diagnostic.CONTAINED_HELPER, "utf8");
  for (const token of ["AreAccessRulesProtected", "AccessControlType]::Allow", "FileSystemRights]::FullControl", "PropagationFlags]::None", "ObjectInherit", "ContainerInherit", "ReparsePoint", "GetFileInformationByHandle", "GetFinalPathNameByHandle", "NumberOfLinks -ne 1"]) assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("contained helper creates suspended with restricted handles and assigns job before resume", () => {
  const source = fs.readFileSync(diagnostic.CONTAINED_HELPER, "utf8");
  for (const token of ["CreateProcessW", "CREATE_SUSPENDED", "PROC_THREAD_ATTRIBUTE_HANDLE_LIST", "UpdateProcThreadAttribute", "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE", "AssignProcessToJobObject", "ResumeThread", "TerminateProcess", "WaitForSingleObject", "ActiveZero"]) assert.match(source, new RegExp(token, "u"));
  assert.equal(source.indexOf("AssignProcessToJobObject(job,pi.hProcess)") < source.indexOf("ResumeThread(pi.hThread)"), true); assert.doesNotMatch(source, /\$process\.Start\(|\[Diagnostics\.Process\]::new/u);
});

test("defaultSnapshot traverses both real probe paths and independently validates", () => {
  const calls = [], snapshot = diagnostic.defaultSnapshot({ spawnSync: routedSpawn(linuxPass(), { ok: true }, calls) }); assert.equal(calls.length, 2); assert.deepEqual(calls.map((x) => x.args[7]), ["WSL_PROBE", "ACL_PROBE"]);
  const result = diagnostic.classify({ snapshot, synthetic: synthetic() }); assert.equal(result.overall, "BLOCKED_EXPIRED"); assert.equal(result.safety.wslChildExecutions, 1); assert.equal(result.safety.powershellChildExecutions, 2); assert.equal(result.safety.containedChildExecutions, 1); assert.equal(result.safety.childTreeCleanupConfirmations, 1); validator.validate(clone(result));
});

test("wrong archive cannot substitute when active permit is absent", () => {
  const calls = [], snapshot = diagnostic.defaultSnapshot({ spawnSync: routedSpawn(linuxPass("absent", 0), { ok: true }, calls) }); const result = diagnostic.classify({ snapshot, synthetic: synthetic() });
  assert.equal(result.phases.P05, "P05_ACTIVE_PERMIT_ABSENT"); assert.equal(result.safety.productionPermitReads, 0); assert.equal(calls.length, 2);
});

test("Linux probe rejects child JSON extras malformed output and protocol extras", () => {
  const extra = { ...linuxPass(), archiveAccepted: true }; assert.equal(diagnostic.probeLinux({ spawnSync: () => protocol(extra) }).data.p01, false);
  assert.equal(diagnostic.probeLinux({ spawnSync: () => protocol("{") }).data.p01, false);
  const wrapperExtra = protocol(linuxPass()); wrapperExtra.stdout = JSON.stringify({ ...JSON.parse(wrapperExtra.stdout), extra: true }); assert.equal(diagnostic.probeLinux({ spawnSync: () => wrapperExtra }).data.p01, false);
});

test("ACL probe rejects malformed or extra output", () => {
  assert.equal(diagnostic.probeWindowsAcl({ spawnSync: () => protocol({ ok: true, extra: false }) }).ok, false); assert.equal(diagnostic.probeWindowsAcl({ spawnSync: () => protocol("not-json") }).ok, false); assert.equal(diagnostic.probeWindowsAcl({ spawnSync: () => protocol({ ok: "true" }) }).ok, false);
});

test("contained protocol accepts confirmed timeout and rejects unconfirmed tree", () => {
  const timeout = protocol("123", { kind: "TIMEOUT", exitCode: null }); const result = diagnostic.runContainedChild("SELFTEST_TIMEOUT", "", () => timeout, 1000); assert.equal(result.kind, "TIMEOUT"); assert.equal(result.treeTerminated, true);
  const unconfirmed = protocol("", { kind: "TIMEOUT", exitCode: null, treeTerminated: false }); assert.throws(() => diagnostic.runContainedChild("SELFTEST_TIMEOUT", "", () => unconfirmed, 1000), /CHILD_PROTOCOL/u);
});

test("real containment timeout confirms descendant tree is gone", () => {
  const result = diagnostic.runContainedChild("SELFTEST_TIMEOUT", "", childProcess.spawnSync, 10000); assert.equal(result.kind, "TIMEOUT"); assert.equal(result.treeTerminated, true);
  const pid = Number(result.stdout.toString("ascii")); assert.equal(Number.isInteger(pid) && pid > 0, true); assert.throws(() => process.kill(pid, 0)); assert.throws(() => process.kill(result.childPid, 0)); assert.equal(result.jobActiveProcesses, 0);
});

test("job create set assign and resume faults kill exact suspended PID before delayed side effect", () => {
  const rows = [["SELFTEST_JOB_CREATE", "JOB_CREATE_ERROR"], ["SELFTEST_JOB_SET", "JOB_SET_ERROR"], ["SELFTEST_JOB_ASSIGN", "JOB_ASSIGN_ERROR"], ["SELFTEST_RESUME", "RESUME_ERROR"]];
  for (const [mode, kind] of rows) {
    const result = diagnostic.runContainedChild(mode, "", childProcess.spawnSync, 10000); assert.equal(result.kind, kind); assert.equal(result.treeTerminated, true); assert.equal(result.processExited, true); assert.equal(result.jobActiveProcesses, 0); assert.equal(result.childPid > 0, true); assert.throws(() => process.kill(result.childPid, 0)); assert.equal(path.dirname(result.sideEffectPath), TEMP_PARENT); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900); assert.equal(fs.existsSync(result.sideEffectPath), false);
  }
});

test("absolute executable pins prevent basename substitution", () => {
  assert.equal(diagnostic.WSL, "C:\\Windows\\System32\\wsl.exe"); assert.equal(diagnostic.POWERSHELL, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"); assert.equal(path.win32.isAbsolute(diagnostic.WSL), true); assert.equal(path.win32.basename(diagnostic.WSL), "wsl.exe");
  const helper = fs.readFileSync(diagnostic.CONTAINED_HELPER, "utf8"); assert.match(helper, /C:\\Windows\\System32\\wsl\.exe/u); assert.doesNotMatch(helper, /FileName\s*=\s*["']wsl\.exe/u);
});

test("synthetic nonce and prelude mutations reject exactly", () => {
  const nonce = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n"); assert.equal(diagnostic.validateSyntheticNonce(nonce), true);
  for (const value of [nonce.subarray(0, 64), Buffer.from(nonce).fill(0x61), Buffer.from(`${"00".repeat(32)}\n`)]) assert.equal(diagnostic.validateSyntheticNonce(value), false);
  const prelude = diagnostic.buildSyntheticPrelude(); assert.equal(diagnostic.parseSyntheticPrelude(prelude), true); for (const index of [0, 8, 12, 76, 108, 148, 155]) { const changed = Buffer.from(prelude); changed[index] ^= 1; assert.equal(diagnostic.parseSyntheticPrelude(changed), false); }
});

test("strict Linux complete binding set rejects mode canonical missing extra and held-file tamper", () => {
  const records = new Map([["/a", { dev: 7, ino: 11, uid: 1000, nlink: 1, mode: 0o100555 }], ["/b", { dev: 7, ino: 12, uid: 1000, nlink: 1, mode: 0o100444 }]]), fds = new Map(); let next = 20;
  const ops = { constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 }, realpathSync(value) { if (value.startsWith("/proc/self/fd/")) return fds.get(Number(value.slice(value.lastIndexOf("/") + 1))).path; const row = records.get(value); if (!row) throw new Error("MISSING"); return row.real || value; }, lstatSync(value) { const row = records.get(value); if (!row) throw new Error("MISSING"); return { ...row, isFile: () => true, isSymbolicLink: () => false }; }, statfsSync: () => ({ type: 0xef53 }), openSync(value) { const fd = next++; fds.set(fd, { path: value, row: { ...records.get(value) } }); return fd; }, fstatSync(fd) { const row = fds.get(fd).row; return { ...row, isFile: () => true }; }, closeSync(fd) { fds.delete(fd); } };
  assert.equal(diagnostic.qualifyLinuxFileSet(ops, ["/a", "/b"], 2), true);
  records.get("/b").mode |= 0o002; assert.equal(diagnostic.qualifyLinuxFileSet(ops, ["/a", "/b"], 2), false); records.get("/b").mode &= ~0o002;
  records.get("/b").real = "/elsewhere"; assert.equal(diagnostic.qualifyLinuxFileSet(ops, ["/a", "/b"], 2), false); delete records.get("/b").real;
  assert.equal(diagnostic.qualifyLinuxFileSet(ops, ["/a", "/missing"], 2), false); assert.equal(diagnostic.qualifyLinuxFileSet(ops, ["/a", "/b", "/extra"], 2), false);
  const originalFstat = ops.fstatSync; ops.fstatSync = (fd) => ({ ...originalFstat(fd), ino: 999, isFile: () => true }); assert.equal(diagnostic.qualifyLinuxFileSet(ops, ["/a", "/b"], 2), false);
  const source = diagnostic.linuxProbeSource(); assert.match(source, /Object\.values\(PROD\)\.map/u); assert.match(source, /Object\.values\(OFF\)\.map/u); assert.match(source, /2\+Object\.keys\(PROD\)\.length\+Object\.keys\(OFF\)\.length/u);
});

test("complete independently-built permit bridge and deterministic permitId reject every field and key tamper", () => {
  const bridge = { inputMode: "mode", exclusiveWriterFramedGo: true, windowsPeerEofRequired: false, linuxWriterClosedAfterGo: true, bufferedTrailingBytesRejected: true, postGoChannelMonitored: true, inventoryReadAfterPermanentLock: true, goFrameLayout: { magic: "magic", version: 1, type: 1, sequence: 1, bytes: 156, terminal: "terminal", authCommitment: "SHA256_EXACT_PRELUDE" }, nativeSupervisorDeadlineMs: 3, preGoDeadlineMs: 1, postGoDeadlineMs: 2, nativeSupervisorSourceSha256: "a", nativeSupervisorRuntimeSha256: "b", nativeSupervisorSourceCandidateSha256: "b", nativeBuildManifestSha256: "c", launcherSourceSha256: "d", launcherBinarySha256: "e", nodeExecutableSha256: "f", nodeExecutablePath: "/node", nodeVersion: "v1", productionCapturePath: "/capture", productionCaptureSha256: "g", productionCaptureIdentity: { dev: "7", ino: "8" }, runtimeFilePaths: ["/a", "/b"], nativeMountPolicy: { filesystems: ["ext4"], requireSameIdentity: true, uid: 1000, regularFileNlink: 1, forbidGroupOtherWrite: true }, nativeMountIdentity: { mountId: 1, majorMinor: "8:1", root: "/", mountPoint: "/", fsType: "ext4", source: "/dev/x" } };
  const expected = { schema: "permit/v1", mode: "read-only", productionHashes: { a: "1" }, offlineHashes: { b: "2" }, policyHash: "p", policy: { hash: "p" }, limits: { requests: 1 }, schemas: { capture: "c" }, output: { root: "o" }, hardStops: { routePositive: "unknown" }, runtime: { nodeVersion: "1", platform: "linux", arch: "x64", toolchain: "node-1" }, bridge, maxLifetimeMs: 900000, expiryMs: 1000 };
  const body = { schema: expected.schema, mode: expected.mode, approvalNonceCommitment: "a".repeat(64), issuedAt: 2000, notBefore: 2000, expiresAt: 602000, policyHash: expected.policyHash, productionHashes: expected.productionHashes, offlineHashes: expected.offlineHashes, runtime: expected.runtime, bridge: expected.bridge, policy: expected.policy, limits: expected.limits, schemas: expected.schemas, output: expected.output, hardStops: expected.hardStops };
  const make = (changed = body) => { const permitId = diagnostic.sha256(Buffer.from(diagnostic.canonical({ domain: "morpho-pt-27aug2026-post-expiry-r2-production-permit-id/v1", permit: changed }))); return { schema: changed.schema, permitId, ...Object.fromEntries(Object.entries(changed).slice(1)) }; }, valid = make();
  const digest = (text) => diagnostic.sha256(Buffer.from(text)), check = (value) => diagnostic.checkPermitDocument(value, diagnostic.canonical(value), expected, 700000, diagnostic.canonical, digest);
  assert.deepEqual(check(valid), { structure: true, policyTools: true, runtimeBridge: true, time: true, state: "expired" });
  const paths = []; const walk = (value, prefix = []) => { for (const [key, item] of Object.entries(value)) item && typeof item === "object" && !Array.isArray(item) ? walk(item, [...prefix, key]) : paths.push([...prefix, key]); }; walk(bridge);
  for (const fieldPath of paths) { const changed = clone(body), parent = fieldPath.slice(0, -1).reduce((x, key) => x[key], changed.bridge), key = fieldPath.at(-1); parent[key] = typeof parent[key] === "boolean" ? !parent[key] : typeof parent[key] === "number" ? parent[key] + 1 : Array.isArray(parent[key]) ? [...parent[key], "/extra"] : `${parent[key]}-tampered`; const result = check(make(changed)); assert.equal(result.structure, true); assert.equal(result.runtimeBridge, false); }
  const objects = [[]]; const collectObjects = (value, prefix = []) => { for (const [key, item] of Object.entries(value)) if (item && typeof item === "object" && !Array.isArray(item)) { objects.push([...prefix, key]); collectObjects(item, [...prefix, key]); } }; collectObjects(bridge);
  for (const objectPath of objects) { const target = objectPath.reduce((x, key) => x[key], bridge); for (const key of Object.keys(target)) { const changed = clone(body), parent = objectPath.reduce((x, part) => x[part], changed.bridge); delete parent[key]; assert.equal(check(make(changed)).runtimeBridge, false); } const changed = clone(body), parent = objectPath.reduce((x, part) => x[part], changed.bridge); parent.unexpected = true; assert.equal(check(make(changed)).runtimeBridge, false); }
  for (const field of ["productionHashes", "offlineHashes"]) { const changed = clone(body); changed[field][Object.keys(changed[field])[0]] = "tampered"; assert.equal(check(make(changed)).policyTools, false); }
  const wrongId = clone(valid); wrongId.permitId = "0".repeat(64); assert.equal(check(wrongId).structure, false);
});

test("P08 and P09 count mutations and remove every synthetic root", () => {
  const before = new Set(fs.readdirSync(TEMP_PARENT)), durability = diagnostic.runSyntheticDurability(TEMP_PARENT), lock = diagnostic.runSyntheticLock(TEMP_PARENT); assert.deepEqual(durability, { ok: true, mutationOperations: 4, cleanupOperations: 1 }); assert.deepEqual(lock, { ok: true, mutationOperations: 3, cleanupOperations: 1 }); assert.deepEqual(new Set(fs.readdirSync(TEMP_PARENT)), before);
});

test("mutation path guard rejects production permit output and inventory paths", () => {
  const root = path.join(TEMP_PARENT, "morpho-r4-guard"); for (const target of [path.join("C:\\", "_Work", "__EVM_AUDIT", ".runtime", "production-output"), path.join("C:\\", "_Work", "__EVM_AUDIT", "rpc_" + "endpoints.txt"), path.join("C:\\", "_Work", "__EVM_AUDIT", "permit.json")]) assert.throws(() => diagnostic.assertSyntheticTarget(root, target), /SYNTHETIC_PATH_GUARD/u);
});

test("real default probe path never reads inventory through local fs", () => {
  const original = fs.readFileSync; let inventoryReads = 0; fs.readFileSync = function guarded(file, ...args) { if (String(file).toLowerCase().includes(`rpc_${"endpoints"}.txt`)) { inventoryReads++; throw new Error("INVENTORY"); } return original.call(this, file, ...args); };
  try { const snapshot = diagnostic.defaultSnapshot({ spawnSync: routedSpawn() }); diagnostic.classify({ snapshot, synthetic: synthetic() }); } finally { fs.readFileSync = original; }
  assert.equal(inventoryReads, 0);
});

test("module loading forbids transports and production capture import", () => {
  const source = `const M=require('node:module'),old=M._load,bad=new Set(['node:dns','dns','node:http','http','node:https','https','node:net','net','node:tls','tls']);M._load=function(r,p,m){if(bad.has(r)||/capture-morpho-pt-27aug2026-post-expiry-r2-production\\.js$/.test(r))throw Error('FORBIDDEN:'+r);return old.apply(this,arguments)};require(${JSON.stringify(path.join(__dirname, "diagnose-morpho-pt-27aug2026-post-expiry-r4-pre-go.js"))});`;
  const result = childProcess.spawnSync(process.execPath, ["-e", source], { encoding: "utf8", windowsHide: true }); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
});

test("source has no transport inventory production runner or archive fallback", () => {
  const source = fs.readFileSync(path.join(__dirname, "diagnose-morpho-pt-27aug2026-post-expiry-r4-pre-go.js"), "utf8"); assert.doesNotMatch(source, /runNativeProduction|publishBundle|require\(["']node:(?:dns|http|https|net|tls)["']\)|rpc_endpoints\.txt|\.expired\.json/u); assert.doesNotMatch(source, /require\(["'].+capture-morpho-pt-27aug2026-post-expiry-r2-production\.js["']\)/u); assert.doesNotMatch(source, /spawnSync\(["']wsl\.exe["']/u);
});

test("validator rejects extras leaks status drift and every counter inconsistency", () => {
  const base = clone(diagnostic.classify({ snapshot: pass(), synthetic: synthetic() }));
  const mutations = [x => { x.extra = true; }, x => { x.phases.P01 = "P01_OTHER"; }, x => { x.safety.networkRequests = 1; }, x => { x.safety.captureExecutions = 1; }, x => { x.safety.productionPermitReads = 0; }, x => { x.safety.wslChildExecutions = 0; }, x => { x.safety.powershellChildExecutions = 3; }, x => { x.safety.containedChildExecutions = 2; }, x => { x.safety.childTreeCleanupConfirmations = 2; }, x => { x.safety.syntheticMutationOperations = 6; }, x => { x.safety.syntheticCleanupOperations = 1; }, x => { x.overall = "PASS_LIMITED"; }, x => { x.phases.P10 = "C:\\secret"; }, x => { x.phases.P10 = "a".repeat(64); }];
  for (const mutate of mutations) { const value = clone(base); mutate(value); assert.throws(() => validator.validate(value)); }
});

test("validator aborts oversized stdin above 8192 bytes without output", () => {
  assert.equal(validator.MAX_STDIN_BYTES, 8192); const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, "validate-diagnose-morpho-pt-27aug2026-post-expiry-r4-pre-go.js")], { input: Buffer.alloc(8193, 0x20), encoding: "utf8", windowsHide: true, maxBuffer: 16384 }); assert.notEqual(result.status, 0); assert.equal(result.stdout, "");
});

test.after(() => process.stdout.write(`${JSON.stringify({ suite: "MORPHO_PT_R4_PRE_GO_OFFLINE_V2", tests: 26, captureExecutions: 0, issuerExecutions: 0, conductorExecutions: 0, inventoryReads: 0, networkRequests: 0, productionMutations: 0 })}\n`));
