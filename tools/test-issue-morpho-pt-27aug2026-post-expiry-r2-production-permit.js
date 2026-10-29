#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const issuer = require("./issue-morpho-pt-27aug2026-post-expiry-r2-production-permit.js");
const adapter = require("./lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js");
const { POLICY, POLICY_HASH, canonical } = require("./morpho-pt-27aug2026-post-expiry-r2-production-policy.js");

const NONCE = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f";
const NONCE_LINE = Buffer.from(`${NONCE}\n`);
const NOW = 1787792400000;
const clone = (value) => JSON.parse(JSON.stringify(value));
const bindings = () => ({
  productionHashes: { policy: "01".repeat(32), adapter: "02".repeat(32), capture: "03".repeat(32), validator: "04".repeat(32), test: "05".repeat(32), nativeSupervisorSource: "06".repeat(32), nativeSupervisorSourceCandidate: "07".repeat(32), nativeBuildManifest: "08".repeat(32), launcherSource: "09".repeat(32), launcherBinary: "0a".repeat(32) },
  offlineHashes: { profile: "11".repeat(32), engine: "12".repeat(32), validator: "13".repeat(32), test: "14".repeat(32), disabledCapture: "15".repeat(32), sharedGate: "16".repeat(32), inventoryParser: "17".repeat(32) },
  runtime: { nodeVersion: process.versions.node, platform: "linux", arch: "x64", toolchain: `node-${process.versions.modules}` },
  bridge: { inputMode: POLICY.input.mode, exclusiveWriterFramedGo: true, windowsPeerEofRequired: false, linuxWriterClosedAfterGo: true, bufferedTrailingBytesRejected: true, postGoChannelMonitored: true, inventoryReadAfterPermanentLock: true, goFrameLayout: { magic: POLICY.input.goMagic, version: POLICY.input.goVersion, type: POLICY.input.goType, sequence: POLICY.input.goSequence, bytes: POLICY.input.goBytes, terminal: POLICY.input.goTerminal, authCommitment: "SHA256_EXACT_PRELUDE" }, nativeSupervisorDeadlineMs: POLICY.input.nativeSupervisorDeadlineMs, preGoDeadlineMs: POLICY.input.preGoDeadlineMs, postGoDeadlineMs: POLICY.input.postGoDeadlineMs, nativeSupervisorSourceSha256: "06".repeat(32), nativeSupervisorRuntimeSha256: "07".repeat(32), nativeSupervisorSourceCandidateSha256: "07".repeat(32), nativeBuildManifestSha256: "08".repeat(32), launcherSourceSha256: "09".repeat(32), launcherBinarySha256: "0a".repeat(32), nodeExecutableSha256: "0b".repeat(32), nodeExecutablePath: POLICY.input.nodePath, nodeVersion: POLICY.input.nodeVersion, productionCapturePath: POLICY.input.capturePath, productionCaptureSha256: "03".repeat(32), productionCaptureIdentity: { dev: "1", ino: "2" }, runtimeFilePaths: [POLICY.input.capturePath], nativeMountPolicy: clone(POLICY.input.mountPolicy), nativeMountIdentity: { mountId: 1, majorMinor: "0:1", root: "/", mountPoint: "/", fsType: "ext4", source: "/dev/test" } },
});

let root, permitParent, outputRoot, authority;
function reset() {
  fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(permitParent, { recursive: true }); fs.mkdirSync(outputRoot, { recursive: true });
}
function issue(overrides = {}) { return issuer.issuePermit({ root, stdinBytes: NONCE_LINE, bindings: bindings(), clock: () => NOW, fsOps: fs, authority, ...overrides }); }

test.before(() => {
  const parent = path.join(os.tmpdir(), "opencode"); fs.mkdirSync(parent, { recursive: true }); root = fs.mkdtempSync(path.join(parent, "r2-permit-issuer-unit-"));
  permitParent = path.join(root, "permits"); outputRoot = path.join(root, POLICY.output.root); authority = { uid: fs.lstatSync(root).uid, fsType: () => issuer.EXT4_MAGIC, directorySecure: () => true, fsyncDirectory() {}, unlinkTemporary(temp, permit, fsOps) { if (process.platform === "win32") fsOps.chmodSync(temp, 0o600); fsOps.unlinkSync(temp); if (process.platform === "win32") fsOps.chmodSync(permit, 0o444); } }; reset();
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("nonce requires exact lowercase 64-hex line, EOF shape, and diversity", () => {
  assert.equal(issuer.validateNonceLine(NONCE_LINE), NONCE);
  for (const value of [Buffer.from(NONCE), Buffer.from(`${NONCE}\nextra`), Buffer.from(`${NONCE.toUpperCase()}\n`), Buffer.from(`${"00".repeat(32)}\n`)]) assert.throws(() => issuer.validateNonceLine(value), (error) => error.code === "NONCE_STDIN");
});

test("direct invocation is pinned to Linux runtime identity and sealed environment", () => {
  const valid = { argv: [issuer.NODE, issuer.SELF], execArgv: [], env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" }, execPath: issuer.NODE, filename: issuer.SELF, platform: "linux", uid: 1000, euid: 1000, gid: 1000, egid: 1000 };
  assert.equal(issuer.validateDirectInvocation(valid), true);
  for (const mutation of [{ ...valid, argv: [...valid.argv, "x"] }, { ...valid, env: { ...valid.env, RPC_URL: "forbidden" } }, { ...valid, execArgv: ["--inspect"] }, { ...valid, uid: 0 }, { ...valid, filename: `${valid.filename}.other` }]) assert.throws(() => issuer.validateDirectInvocation(mutation), (error) => error.code === "INVOCATION" || error.code === "ENV");
});

test("permit is canonical, deterministic, valid, and exactly ten minutes", () => {
  const first = issuer.buildPermit({ nonce: NONCE, bindings: bindings(), now: NOW }), second = issuer.buildPermit({ nonce: NONCE, bindings: bindings(), now: NOW });
  assert.deepEqual(first, second); assert.equal(first.issuedAt, NOW); assert.equal(first.notBefore, NOW); assert.equal(first.expiresAt, NOW + 600000); assert.equal(first.policyHash, POLICY_HASH); assert.equal(first.permitId, second.permitId);
  assert.equal(adapter.validatePermit(first, { nonce: NONCE, bindings: bindings(), now: NOW }), first);
  assert.equal(Buffer.from(canonical(first)).includes(0x0a), false);
});

test("exclusive hardlink publication produces one immutable canonical permit", () => {
  reset(); const result = issue(), stat = fs.lstatSync(result.permitPath);
  assert.equal(fs.readFileSync(result.permitPath).equals(result.bytes), true); assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1); assert.equal(stat.mode & 0o777, 0o444); assert.equal(stat.uid, authority.uid); assert.equal(fs.readdirSync(permitParent).length, 1); assert.equal(fs.readdirSync(outputRoot).length, 0);
});

test("existing permit and dirty output fail before publication", () => {
  reset(); const permit = path.join(root, POLICY.permit.path); fs.writeFileSync(permit, "existing"); assert.throws(() => issue(), (error) => error.code === "PERMIT_EXISTS");
  reset(); fs.writeFileSync(path.join(outputRoot, POLICY.output.lock), "dirty"); assert.throws(() => issue(), (error) => error.code === "OUTPUT_NOT_CLEAN"); assert.equal(fs.existsSync(permit), false);
  reset(); fs.mkdirSync(path.join(outputRoot, `${POLICY.output.runPrefix}dirty`)); assert.throws(() => issue(), (error) => error.code === "OUTPUT_NOT_CLEAN"); assert.equal(fs.existsSync(permit), false);
});

test("checked writes tolerate EINTR and short writes without temporary remnants", () => {
  reset(); let calls = 0; const fsOps = Object.create(fs); fsOps.writeSync = (fd, bytes, offset, length, position) => { calls++; if (calls === 1) { const error = new Error("interrupted"); error.code = "EINTR"; throw error; } return fs.writeSync(fd, bytes, offset, Math.min(7, length), position); };
  const result = issue({ fsOps }); assert.ok(calls > 2); assert.equal(fs.existsSync(result.permitPath), true); assert.equal(fs.readdirSync(permitParent).some((name) => name.endsWith(".tmp")), false);
});

test("source contains no inventory, transport, lock, output, or publication invocation", () => {
  const source = fs.readFileSync(path.join(__dirname, "issue-morpho-pt-27aug2026-post-expiry-r2-production-permit.js"), "utf8");
  assert.doesNotMatch(source, /rpc_endpoints|node:dns|node:https|strictRequest|acquireOneShotLock|publishBundle|runNativeProduction\s*\(/u);
  assert.match(source, /process\.exitCode\s*=/u); assert.doesNotMatch(source, /process\.exit\s*\(/u);
});
