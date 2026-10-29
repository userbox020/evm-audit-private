#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const common = require("./polygon-robin-runtime-r2-common");
const pkg = require("./polygon-robin-runtime-r2-package");
const broker = require("./polygon-robin-runtime-r2-broker");

const PASS = "ROBIN_RUNTIME_R2_CAPABILITY_PASS";
const FAIL = "ROBIN_RUNTIME_R2_CAPABILITY_FAIL";
const ALLOWED_PRE = new Set(["capability-test", "lifecycle", "review-input", "reviews", "reports", "staging-seal.json", "tools"]);

async function durableUnlink(file) { await fsp.unlink(file); await common.syncDirectory(file); try { await fsp.lstat(file); common.fail("CLEANUP_OR_DIR_FSYNC_FAILURE"); } catch (error) { if (error instanceof common.R2Error) throw error; if (error?.code !== "ENOENT") throw error; } }
async function exercise(testDir) {
  const file = path.join(testDir, "create.bin"), renamed = path.join(testDir, "renamed.bin"), faultTarget = path.join(testDir, "fault.bin"), payload = Buffer.from("robin-runtime-r2-durability\n");
  common.requireDurable(await common.durableCreate(file, payload, { token: "normal" }));
  const existing = await common.durableCreate(file, payload, { token: "exists", authenticateExisting: async (target, expected) => (await fsp.readFile(target)).equals(expected) });
  if (existing.status !== common.CREATE.TARGET_EXISTS_AUTHENTICATED) common.fail("CLEANUP_OR_DIR_FSYNC_FAILURE");
  await fsp.rename(file, renamed); await common.syncDirectory(renamed); if (!(await fsp.readFile(renamed)).equals(payload)) common.fail("CLEANUP_OR_DIR_FSYNC_FAILURE");
  await durableUnlink(renamed);
  const fault = await common.durableCreate(faultTarget, payload, { token: "post-link", fault: async (phase) => { if (phase === "AFTER_LINK") throw new Error("INJECTED"); } });
  if (fault.status !== common.CREATE.INDETERMINATE_AFTER_LINK || fault.targetPublishedByCurrentOperation !== true) common.fail("INDETERMINATE_AFTER_LINK");
  for (const item of [faultTarget, path.join(testDir, ".fault.bin.post-link.r2tmp")]) { try { await fsp.unlink(item); } catch (error) { if (error?.code !== "ENOENT") common.fail("CLEANUP_OR_DIR_FSYNC_FAILURE"); } }
  const dir = await fsp.open(testDir, "r"); try { await dir.sync(); } catch (_) { common.fail("CLEANUP_OR_DIR_FSYNC_FAILURE"); } finally { await dir.close(); }
  if ((await fsp.readdir(testDir)).length !== 0) common.fail("CLEANUP_OR_DIR_FSYNC_FAILURE");
  return { exclusiveCreate: true, fileFsync: true, hardlinkReadback: true, targetParentFsync: true, renameParentFsync: true, unlinkParentFsync: true,
    cleanupAbsence: true, injectedAfterLinkStatus: common.CREATE.INDETERMINATE_AFTER_LINK };
}
async function verifyStaging(root, user) {
  const sealPath = path.join(root, "staging-seal.json"), bytes = (await common.secureRead(sealPath, { uid: user.uid, cap: common.CAPS.outputLifecycleBytes })).bytes, seal = common.parseCanonicalJson(bytes), snapshots = new Map([[path.resolve(sealPath), bytes]]);
  for (const row of seal.records || []) { const target = path.join(root, ...common.safeRelative(row.stagedLogicalPath).split("/")); snapshots.set(path.resolve(target), (await common.readStagedRecord(target, row, { uid: user.uid })).bytes); }
  const manifestPath = path.join(root, pkg.PACKAGE_REL, "package-manifest.json"), authority = pkg.verifyAll({ root, manifestPath, readFile: (file) => { const value = snapshots.get(path.resolve(file)); if (!value) common.fail("PACKAGE_NODE_SEAL_MISMATCH"); return value; } });
  if (seal.schemaVersion !== "robin-runtime-r2/staging-seal-v4" || seal.status !== "NATIVE_CANDIDATE_PENDING_EXT4_CAPABILITY" || seal.nativeRoot !== root || seal.verifiedUser?.uid !== user.uid
    || seal.packageManifestSha256 !== authority.packageManifestSha256 || seal.packageAggregateSha256 !== authority.packageAggregateSha256
    || seal.recordAggregateSha256 !== common.sha256(Buffer.from(common.canonical(seal.records))) || common.canonical(seal.records.map((x) => x.stagedLogicalPath).sort())
      !== common.canonical([...authority.packageRecords.map((x) => x.path), `${pkg.PACKAGE_REL}/package-manifest.json`].sort())) common.fail("PACKAGE_NODE_SEAL_MISMATCH");
  const node = common.nodeAuthority(); if (common.canonical(node) !== common.canonical(seal.node)) common.fail("PACKAGE_NODE_SEAL_MISMATCH");
  const launcherRecord = authority.packageRecords.find((row) => row.path === common.NATIVE_LAUNCHER_RELATIVE), expectedRecords = [...authority.packageRecords, { path: `${pkg.PACKAGE_REL}/package-manifest.json`, bytes: authority.bytes.length, sha256: authority.packageManifestSha256 }].sort((a, b) => a.path.localeCompare(b.path)).map((row) => ({ originLogicalPath: row.path, stagedLogicalPath: row.path, bytes: row.bytes, sha256: row.sha256, mode: common.recordExpectedMode(row.path) === 0o700 ? "0700" : "0600" })); common.validateStagingSeal(seal, { root, verifiedUser: { uid: user.uid, gid: user.gid, home: user.home }, records: expectedRecords, packageManifestSha256: authority.packageManifestSha256, packageAggregateSha256: authority.packageAggregateSha256, node, nativeLauncher: { ...launcherRecord, mode: "0700" } });
  for (const row of seal.records) { const target = path.join(root, ...common.safeRelative(row.stagedLogicalPath).split("/")), real = fs.realpathSync(target), data = snapshots.get(path.resolve(target)), stat = fs.lstatSync(target);
    const expectedMode = common.recordExpectedMode(row.stagedLogicalPath); if (!real.startsWith(`${root}/`) || real.startsWith("/mnt/c/") || stat.isSymbolicLink() || !stat.isFile() || stat.uid !== user.uid || (stat.mode & 0o777) !== expectedMode || row.mode !== (expectedMode === 0o700 ? "0700" : "0600") || data.length !== row.bytes || common.sha256(data) !== row.sha256) common.fail("RUNTIME_AUTHORITY_MNT_C"); }
  return { seal, bytes, authority, node };
}
async function exerciseV9fs(options = {}) {
  const fixture = options.fixture || `/mnt/c/_Work/__EVM_AUDIT/${pkg.PACKAGE_REL}/capability-fixture/payload.txt`, parent = path.dirname(fixture), symlink = path.join(parent, ".r2-capability-symlink"), hardlink = path.join(parent, ".r2-capability-hardlink"), result = { exactPathNofollow: false, symlinkRejected: false, aliasRejected: false, hardlinkRejected: false, preOpenPostIdentity: false, cleaned: false, parentDurabilityClaim: false };
  const first = await common.secureRead(fixture, { cap: 4096, mode: null }); result.exactPathNofollow = true; result.preOpenPostIdentity = Boolean(first.identity.dev && first.identity.ino);
  try { await fsp.symlink(fixture, symlink); try { await common.secureRead(symlink, { cap: 4096, mode: null }); } catch (_) { result.symlinkRejected = true; result.aliasRejected = true; } await fsp.unlink(symlink);
    await fsp.link(fixture, hardlink); try { await common.secureRead(fixture, { cap: 4096, mode: null }); } catch (_) { result.hardlinkRejected = true; } await fsp.unlink(hardlink);
  } finally { await fsp.unlink(symlink).catch(() => {}); await fsp.unlink(hardlink).catch(() => {}); result.cleaned = !(fs.existsSync(symlink) || fs.existsSync(hardlink)); }
  if (Object.entries(result).some(([key, value]) => key !== "parentDurabilityClaim" && value !== true) || result.parentDurabilityClaim !== false) common.fail("BROKER_IDENTITY_UNPROVEN"); return result;
}
async function exerciseBrokerV9fs(options = {}) {
  if (options.synthetic === true) { const paths = [0,1,2,3].map((i) => `/fixture/${i}`), data = paths.map((_x, i) => Buffer.from(`synthetic-${i}\n`)), factory = options.operationsFactory; if (typeof factory !== "function") common.fail("BROKER_IDENTITY_UNPROVEN"); const runReject = async (mutation, extra = {}) => { try { await broker.readFiles({ paths, synthetic: true, operations: factory(data, mutation), noFollowFlag: 1, now: () => 0, ...extra }); return false; } catch (_) { return true; } }, normal = await broker.readFiles({ paths, synthetic: true, operations: factory(data, {}), noFollowFlag: 1, now: () => 0 }); return { status: "SYNTHETIC_BRANCH_COVERAGE_STOP_PRODUCTION_V9FS_REQUIRED", files: 4, normalRead: normal.length === 4, eofProven: broker.parseFrames(Buffer.concat([...normal.map((x, i) => broker.frame(i, x)), broker.frame(255)])).length === 4, symlinkRejected: await runReject({ symlink: true }), hardlinkRejected: await runReject({ nlink: 2 }), aliasRejected: await runReject({ alias: true }), identityDriftRejected: await runReject({ swap: true }), fileCapRejected: await runReject({}, { caps: { fileBytes: 1 } }), aggregateCapRejected: await runReject({}, { caps: { aggregateBytes: 1 } }), deadlineRejected: await runReject({}, { now: (() => { let n = 0; return () => n++ ? broker.CAPS.deadlineMs : 0; })() }), actualInventoriesOpened: false, cleaned: true, parentDurabilityClaim: false }; }
  const fixture = options.fixture || `/mnt/c/_Work/__EVM_AUDIT/${pkg.PACKAGE_REL}/capability-fixture/payload.txt`, parent = path.dirname(fixture), paths = Array.from({ length: 4 }, (_, i) => path.join(parent, `.r2-broker-fixture-${i}.txt`));
  const result = { status: "PASS_DISPOSABLE_FOUR_FILES", files: 4, normalRead: false, eofProven: false, symlinkRejected: false, hardlinkRejected: false, aliasRejected: false, identityDriftRejected: false, fileCapRejected: false, aggregateCapRejected: false, deadlineRejected: false, actualInventoriesOpened: false, cleaned: false, parentDurabilityClaim: false }; let passed = false; try { for (let i = 0; i < paths.length; i += 1) await fsp.writeFile(paths[i], Buffer.from(`robin-r2-broker-${i}\n`), { flag: "wx", mode: 0o600 }); const rows = await broker.readFiles({ paths, synthetic: true }); if (rows.length !== 4 || rows.some((row, i) => row.toString() !== `robin-r2-broker-${i}\n`)) common.fail("BROKER_IDENTITY_UNPROVEN"); result.normalRead = true; result.eofProven = broker.parseFrames(Buffer.concat([...rows.map((x, i) => broker.frame(i, x)), broker.frame(255)])).length === 4;
    const link = `${paths[0]}.sym`; await fsp.symlink(paths[0], link); try { await broker.readFiles({ paths: [link, ...paths.slice(1)], synthetic: true }); } catch (_) { result.symlinkRejected = true; result.aliasRejected = true; } await fsp.unlink(link); const hard = `${paths[0]}.hard`; await fsp.link(paths[0], hard); try { await broker.readFiles({ paths, synthetic: true }); } catch (_) { result.hardlinkRejected = true; } await fsp.unlink(hard);
    let calls = 0; const driftOps = { ...broker.FILE_OPERATIONS, lstat: async (file) => { const s = await broker.FILE_OPERATIONS.lstat(file); calls += 1; return calls === 2 ? new Proxy(s, { get: (target, key) => key === "ino" ? target.ino + 1n : Reflect.get(target, key, target) }) : s; } }; try { await broker.readFiles({ paths, synthetic: true, operations: driftOps }); } catch (_) { result.identityDriftRejected = true; }
    try { await broker.readFiles({ paths, synthetic: true, caps: { fileBytes: 1 } }); } catch (_) { result.fileCapRejected = true; } try { await broker.readFiles({ paths, synthetic: true, caps: { aggregateBytes: 1 } }); } catch (_) { result.aggregateCapRejected = true; } let tick = 0; try { await broker.readFiles({ paths, synthetic: true, now: () => tick++ ? broker.CAPS.deadlineMs : 0 }); } catch (_) { result.deadlineRejected = true; } passed = true;
  } finally { for (const file of paths) await fsp.unlink(file).catch(() => {}); }
  result.cleaned = !paths.some(fs.existsSync); if (!passed || Object.entries(result).some(([key, value]) => !["status","files","actualInventoriesOpened","parentDurabilityClaim"].includes(key) && value !== true)) common.fail("BROKER_IDENTITY_UNPROVEN"); return result;
}
async function preflight(options = {}) {
  if (process.platform !== "linux" || pkg.ROOT.startsWith("/mnt/c/")) common.fail("LINUX_REQUIRED"); if (!options.skipStartup) common.assertCleanStartup(); process.umask(0o077);
  const user = common.verifiedUser(options), root = path.resolve(pkg.ROOT), expected = path.resolve(user.root); if (root !== expected || fs.realpathSync(root) !== expected) common.fail("ROOT_STATE_INVALID");
  const rootStat = fs.lstatSync(root), names = fs.readdirSync(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== user.uid || (rootStat.mode & 0o777) !== 0o700
    || names.some((name) => !ALLOWED_PRE.has(name))) common.fail("ROOT_STATE_INVALID");
  for (const relative of ["lifecycle", "reviews", "review-input", "capability-test"]) if (fs.readdirSync(path.join(root, relative)).length !== 0) common.fail("ROOT_STATE_INVALID");
  common.assertPathComponents(root, user.uid, { base: user.home }); const testDir = path.join(root, "capability-test"), testStat = fs.lstatSync(testDir); if (!testStat.isDirectory() || testStat.isSymbolicLink() || testStat.uid !== user.uid || fs.readdirSync(testDir).length) common.fail("ROOT_STATE_INVALID");
  if (user.uid === 0) common.fail("ROOT_STATE_INVALID"); const mount = common.assertRuntimeMount(root, path.join(root, "lifecycle"), process.execPath, user.uid, { ...options, home: user.home }), staging = await verifyStaging(root, user), launcherPath = path.join(root, common.NATIVE_LAUNCHER_RELATIVE), launcherProbe = (options.spawnSync || spawnSync)(launcherPath, ["invalid-probe"], { cwd: root, env: { LD_PRELOAD: "/forbidden", LD_LIBRARY_PATH: "/forbidden", NODE_OPTIONS: "--inspect", HTTPS_PROXY: "http://forbidden.invalid", NODE_EXTRA_CA_CERTS: "/forbidden" }, encoding: "utf8" });
  if (launcherProbe.status !== 120 || launcherProbe.stderr !== "R2_LAUNCHER_ARGV\n") common.fail("STARTUP_CONTRACT"); const durability = await exercise(testDir), v9fsFixture = await exerciseV9fs(options), brokerFixture = await exerciseBrokerV9fs(options), nativeLauncher = staging.authority.packageRecords.find((row) => row.path === common.NATIVE_LAUNCHER_RELATIVE);
  const seal = { schemaVersion: "robin-runtime-r2/capability-seal-v4", claimId: common.STEM, status: "PASS_EXT4_V9FS_BROKER_FIXTURE", nativeRoot: root,
    rootAuthority: { uid: user.uid, gid: user.gid, mode: "0700", mountId: mount.mountId, stDev: mount.stDev, filesystem: mount.filesystem, statfsMagic: mount.statfsMagic },
    node: staging.node, packageManifestSha256: staging.authority.packageManifestSha256, packageAggregateSha256: staging.authority.packageAggregateSha256,
    nativeLauncher: { ...nativeLauncher, mode: "0700", hostileEnvironmentProbe: true }, stagingSealSha256: common.sha256(staging.bytes), durability, v9fsFixture, brokerFixture, runtimeAuthorityOnExt4Only: true, stopCodes: common.STOP_CODES };
  common.validateCapabilitySeal(seal, { root, rootAuthority: seal.rootAuthority, packageManifestSha256: staging.authority.packageManifestSha256, packageAggregateSha256: staging.authority.packageAggregateSha256, stagingSealSha256: common.sha256(staging.bytes), node: staging.node, nativeLauncher: seal.nativeLauncher });
  const bytes = Buffer.from(`${common.canonical(seal)}\n`), sealPath = path.join(root, "capability-seal.json"); common.scanCapabilitySeal(seal, { root, rootAuthority: seal.rootAuthority, packageManifestSha256: staging.authority.packageManifestSha256, packageAggregateSha256: staging.authority.packageAggregateSha256, stagingSealSha256: common.sha256(staging.bytes), node: staging.node, nativeLauncher: seal.nativeLauncher }); common.requireDurable(await common.durableCreate(sealPath, bytes, { token: "capability-seal" }));
  if (options.exportReviewInput) {
    const workspace = "/mnt/c/_Work/__EVM_AUDIT", out = path.posix.join(workspace, pkg.PACKAGE_REL, "review-input"); await fsp.mkdir(out, { recursive: true, mode: 0o700 });
    const exports = [["staging-seal.noncanonical.json", staging.bytes], ["capability-seal.noncanonical.json", bytes]];
    for (const [name, data] of exports) common.requireDurable(await common.v9fsCreate(path.join(out, name), data));
  }
  return Object.freeze({ capabilitySealSha256: common.sha256(bytes), packageAggregateSha256: staging.authority.packageAggregateSha256 });
}
async function main(argv = process.argv.slice(2)) { if (argv.length > 1 || argv.length === 1 && argv[0] !== "--export-review-input") common.fail("ARGUMENTS_INVALID"); await preflight({ exportReviewInput: argv.length === 1 }); process.stdout.write(`${PASS}\n`); }
module.exports = { PASS, FAIL, ALLOWED_PRE, durableUnlink, exercise, verifyStaging, exerciseV9fs, exerciseBrokerV9fs, preflight, main };
if (require.main === module) main().catch(() => { process.stdout.write(`${FAIL}\n`); process.exitCode = 1; });
