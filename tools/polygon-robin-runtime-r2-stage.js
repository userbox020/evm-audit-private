#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const common = require("./polygon-robin-runtime-r2-common");
const pkg = require("./polygon-robin-runtime-r2-package");

const PASS = "ROBIN_RUNTIME_R2_STAGING_PASS";
const FAIL = "ROBIN_RUNTIME_R2_STAGING_FAIL";

async function makeOwnedDirectory(directory, user, options = {}) {
  const operations=options.operations||fsp;
  try {
    const row = await operations.lstat(directory),real=await operations.realpath(directory); if (!row.isDirectory() || row.isSymbolicLink() || Number(row.uid) !== user.uid || (Number(row.mode) & 0o777) !== 0o700 || path.resolve(real)!==path.resolve(directory)) common.fail("ROOT_STATE_INVALID");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error; await operations.mkdir(directory, { mode: 0o700 }); const row = await operations.lstat(directory),real=await operations.realpath(directory);
    if (!row.isDirectory() || row.isSymbolicLink() || Number(row.uid) !== user.uid || (Number(row.mode) & 0o777) !== 0o700 || path.resolve(real)!==path.resolve(directory)) common.fail("ROOT_STATE_INVALID");
    await (options.syncDirectory||common.syncDirectory)(directory,operations);
  }
}
async function validateTrustedAncestor(directory,user,options={}){const operations=options.operations||fsp,row=await operations.lstat(directory),real=await operations.realpath(directory),mode=Number(row.mode)&0o777;if(!row.isDirectory()||row.isSymbolicLink()||Number(row.uid)!==user.uid||(mode&0o022)!==0||path.resolve(real)!==path.resolve(directory))common.fail("ROOT_STATE_INVALID");return{path:directory,mode:mode.toString(8).padStart(4,"0")};}
async function ensureTrustedAncestor(directory,user,options={}){try{return await validateTrustedAncestor(directory,user,options);}catch(error){if(error?.code!=="ENOENT")throw error;await makeOwnedDirectory(directory,user,options);return validateTrustedAncestor(directory,user,options);}}
async function prepareNativeTree(user,options={}){await validateTrustedAncestor(user.home,user,options);let current=user.home;for(const part of [".local","share","evm-audit"]){current=path.join(current,part);await ensureTrustedAncestor(current,user,options);}const root=path.join(current,"robin-runtime-r2");if(path.resolve(root)!==path.resolve(user.root))common.fail("ROOT_STATE_INVALID");await makeOwnedDirectory(root,user,options);return root;}
async function secureTree(root, relative, user,options={}) {
  let current = root; for (const part of relative.split("/").filter(Boolean)) { current = path.join(current, part); await makeOwnedDirectory(current, user,options); } return current;
}
function sourceRegular(file, base = pkg.ROOT) { const resolved = path.resolve(file), origin = path.resolve(base); if (!resolved.startsWith(`${origin}${path.sep}`)) common.fail("STAGING_SOURCE_INVALID"); let current = origin;
  for (const part of path.relative(origin, resolved).split(path.sep)) { current = path.join(current, part); const row = fs.lstatSync(current); if (row.isSymbolicLink()) common.fail("STAGING_SOURCE_INVALID"); if (current !== resolved && !row.isDirectory()) common.fail("STAGING_SOURCE_INVALID"); }
  const row = fs.lstatSync(resolved); if (!row.isFile() || row.isSymbolicLink()) common.fail("STAGING_SOURCE_INVALID"); return row; }
async function stage(options = {}) {
  if (process.platform !== "linux" || !pkg.ROOT.startsWith("/mnt/c/")) common.fail("STAGING_MUST_RUN_LINUX_FROM_MNT_C"); if (!options.skipStartup) common.assertCleanStartup(); process.umask(0o077);
  const user = common.verifiedUser(options), root = user.root;
  try { await fsp.lstat(root); common.fail("UNEXPECTED_RESIDUE"); } catch (error) { if (error instanceof common.R2Error) throw error; if (error?.code !== "ENOENT") throw error; }
  await prepareNativeTree(user,options); const manifestPath = pkg.MANIFEST_PATH, manifestBytes = (await common.secureRead(manifestPath, { cap: common.CAPS.outputLifecycleBytes, mode: null })).bytes, manifest = common.parseCanonicalJson(manifestBytes), snapshots = new Map([[path.resolve(manifestPath), manifestBytes]]);
  for (const row of manifest.records) { const origin = pkg.absolute(pkg.ROOT, row.path); sourceRegular(origin); snapshots.set(path.resolve(origin), (await common.secureRead(origin, { cap: row.bytes, mode: null })).bytes); }
  const authority = pkg.verifyAll({ manifestPath, readFile: (file) => { const bytes = snapshots.get(path.resolve(file)); if (!bytes) common.fail("STAGING_SOURCE_INVALID"); return bytes; } });
  const records = [...authority.packageRecords, { path: `${pkg.PACKAGE_REL}/package-manifest.json`, bytes: authority.bytes.length, sha256: authority.packageManifestSha256 }].sort((a, b) => a.path.localeCompare(b.path));
  const staged = [];
  for (const row of records) {
    const origin = pkg.absolute(pkg.ROOT, row.path), bytes = snapshots.get(path.resolve(origin)); if (!bytes || bytes.length !== row.bytes || common.sha256(bytes) !== row.sha256) common.fail("MANIFEST_BINDING");
    const destination = path.join(root, ...row.path.split("/")); await secureTree(root, path.posix.dirname(row.path), user,options); common.requireDurable(await common.durableCreate(destination, bytes)); const expectedMode = common.recordExpectedMode(row.path);
    if (expectedMode === 0o700) { await fsp.chmod(destination, expectedMode); const handle = await fsp.open(destination, "r"); try { await handle.sync(); } finally { await handle.close(); } await common.syncDirectory(destination); }
    const stat = await fsp.lstat(destination); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== user.uid) common.fail("ROOT_STATE_INVALID");
    if ((stat.mode & 0o777) !== expectedMode) common.fail("ROOT_STATE_INVALID"); staged.push({ originLogicalPath: row.path, stagedLogicalPath: row.path, bytes: row.bytes, sha256: row.sha256, mode: expectedMode === 0o700 ? "0700" : "0600" });
  }
  for (const relative of ["lifecycle", "reviews", "review-input", "capability-test"]) await secureTree(root, relative, user,options);
  const node = common.nodeAuthority(), launcher = authority.packageRecords.find((row) => row.path === common.NATIVE_LAUNCHER_RELATIVE), seal = { schemaVersion: "robin-runtime-r2/staging-seal-v4", claimId: common.STEM, status: "NATIVE_CANDIDATE_PENDING_EXT4_CAPABILITY",
    nativeRoot: root, verifiedUser: { uid: user.uid, gid: user.gid, home: user.home }, packageManifestSha256: authority.packageManifestSha256,
    packageAggregateSha256: authority.packageAggregateSha256, node, records: staged, recordAggregateSha256: common.sha256(Buffer.from(common.canonical(staged))),
    nativeLauncher: { ...launcher, mode: "0700" }, modes: { umask: "077",sharedAncestors:"OWNER_CONTROLLED_NO_GROUP_OR_OTHER_WRITE",dedicatedDirectories:"0700", files: "0600", nativeLauncher: "0700" },ancestorPolicy:common.STAGING_ANCESTOR_POLICY, runtimeAuthorityOnExt4OnlyCandidate: true, inventoryException: "BROKER_EXACT_FOUR_COMPILED_PATHS_ONLY" };
  const sealBytes = Buffer.from(`${common.canonical(seal)}\n`); common.scanSanitized(sealBytes); common.requireDurable(await common.durableCreate(path.join(root, "staging-seal.json"), sealBytes));
  return Object.freeze({ root, stagingSealSha256: common.sha256(sealBytes), records: staged.length });
}
async function main(argv = process.argv.slice(2)) { if (argv.length) common.fail("ARGUMENTS_FORBIDDEN"); await stage(); process.stdout.write(`${PASS}\n`); }
module.exports = { PASS, FAIL, makeOwnedDirectory,validateTrustedAncestor,ensureTrustedAncestor,prepareNativeTree, secureTree, sourceRegular, stage, main };
if (require.main === module) main().catch(() => { process.stdout.write(`${FAIL}\n`); process.exitCode = 1; });
