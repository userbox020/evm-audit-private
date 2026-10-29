#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const common = require("./polygon-robin-runtime-r2-common");
const pkg = require("./polygon-robin-runtime-r2-package");

const PASS = "ROBIN_RUNTIME_R2_REVIEW_STAGED";
const FAIL = "ROBIN_RUNTIME_R2_REVIEW_REJECTED";
const ROLES = Object.freeze({ A: "ORACLE_REVIEWER", B: "SECURITY_REVIEWER" });
const IDENTITIES = Object.freeze({ A: "reviewer-a", B: "reviewer-b" });
const KEYS = Object.freeze(["schemaVersion", "claimId", "status", "slot", "reviewerIdentity", "reviewerRole", "reviewerCommitment", "reviewBytesCommitment", "packageManifestSha256", "packageAggregateSha256",
  "stagingSealSha256", "capabilitySealSha256", "launcherSha256", "node", "lifecycleRoot", "executionId", "commands", "brokerContract", "scope", "issuedAt", "expiresAt", "oneRun", "noRetry", "safety"]);
const BROKER_CONTRACT = common.BROKER_CONTRACT;
function reviewBytesCommitment(review) { const copy = structuredClone(review); copy.reviewerCommitment = null; copy.reviewBytesCommitment = null; return common.sha256(Buffer.from(`${common.canonical(copy)}\n`)); }
function commitment(review) { const copy = structuredClone(review); copy.reviewerCommitment = null; return common.sha256(Buffer.from(common.canonical({ object: copy, exactBytesTemplateSha256: review.reviewBytesCommitment }))); }
async function fixedAuthority(root, options = {}) {
  const uid = options.uid, stagingBytes = (await common.secureRead(path.join(root, "staging-seal.json"), { uid, cap: common.CAPS.outputLifecycleBytes })).bytes, capabilityBytes = (await common.secureRead(path.join(root, "capability-seal.json"), { uid, cap: common.CAPS.outputLifecycleBytes })).bytes,
    staging = common.parseCanonicalJson(stagingBytes), capability = common.parseCanonicalJson(capabilityBytes), manifestPath = path.join(root, pkg.PACKAGE_REL, "package-manifest.json"), manifestBytes = (await common.secureRead(manifestPath, { uid, cap: common.CAPS.outputLifecycleBytes })).bytes,
    manifest = common.parseCanonicalJson(manifestBytes), snapshots = new Map([[path.resolve(manifestPath), manifestBytes]]);
  for (const row of manifest.records) snapshots.set(path.resolve(pkg.absolute(root, row.path)), (await common.readStagedRecord(pkg.absolute(root, row.path), row, { uid })).bytes);
  const authority = pkg.verifyAll({ root, manifestPath, readFile: (file) => snapshots.get(path.resolve(file)) || common.fail("PACKAGE_NODE_SEAL_MISMATCH") }), node = common.nodeAuthority(), commands = common.commands(root), launcher = authority.packageRecords.find((row) => row.path === common.NATIVE_LAUNCHER_RELATIVE), nativeLauncher = launcher && { ...launcher, mode: "0700", hostileEnvironmentProbe: true };
  if (!launcher) common.fail("PACKAGE_NODE_SEAL_MISMATCH"); const expectedRecords = [...authority.packageRecords, { path: `${pkg.PACKAGE_REL}/package-manifest.json`, bytes: authority.bytes.length, sha256: authority.packageManifestSha256 }].sort((a, b) => a.path.localeCompare(b.path)).map((row) => ({ originLogicalPath: row.path, stagedLogicalPath: row.path, bytes: row.bytes, sha256: row.sha256, mode: common.recordExpectedMode(row.path) === 0o700 ? "0700" : "0600" })); common.validateStagingSeal(staging, { root, verifiedUser: { uid, gid: staging.verifiedUser.gid, home: staging.verifiedUser.home }, records: expectedRecords, packageManifestSha256: authority.packageManifestSha256, packageAggregateSha256: authority.packageAggregateSha256, node, nativeLauncher: { ...launcher, mode: "0700" } });
  common.validateCapabilitySeal(capability, { root, rootAuthority: capability.rootAuthority, packageManifestSha256: authority.packageManifestSha256, packageAggregateSha256: authority.packageAggregateSha256, stagingSealSha256: common.sha256(stagingBytes), node, nativeLauncher, synthetic: options.syntheticCapability === true });
  return Object.freeze({ authority, node, commands, launcherSha256: launcher.sha256, nativeLauncher, stagingSeal: staging, capabilitySeal: capability, stagingSealSha256: common.sha256(stagingBytes), capabilitySealSha256: common.sha256(capabilityBytes), lifecycleRoot: path.join(root, "lifecycle"), snapshots });
}
function validateReview(review, bytes, fixed, slot, nowMs = Date.now(), requireFresh = true) {
  const data = Buffer.from(bytes), issued = Date.parse(review?.issuedAt), expires = Date.parse(review?.expiresAt); if (!data.equals(Buffer.from(`${common.canonical(review)}\n`))) common.fail("INVALID_REVIEWS");
  if (!common.exactKeys(review, KEYS) || review.schemaVersion !== "robin-runtime-r2/review-record-v3" || review.claimId !== common.STEM || review.status !== "REVIEWED_UNCONSUMED"
    || review.slot !== slot || review.reviewerRole !== ROLES[slot] || review.reviewerIdentity !== IDENTITIES[slot]
    || review.packageManifestSha256 !== fixed.authority.packageManifestSha256 || review.packageAggregateSha256 !== fixed.authority.packageAggregateSha256
    || review.stagingSealSha256 !== fixed.stagingSealSha256 || review.capabilitySealSha256 !== fixed.capabilitySealSha256 || review.launcherSha256 !== fixed.launcherSha256 || common.canonical(review.node) !== common.canonical(fixed.node)
    || review.lifecycleRoot !== fixed.lifecycleRoot || review.executionId !== common.EXECUTION_ID || common.canonical(review.commands) !== common.canonical(fixed.commands)
    || common.canonical(review.brokerContract) !== common.canonical(BROKER_CONTRACT) || common.canonical(review.scope) !== common.canonical(common.REVIEW_SCOPE) || !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > 2 * 60 * 60 * 1000
    || requireFresh && (nowMs < issued || nowMs > expires) || review.oneRun !== true || review.noRetry !== true
    || common.canonical(review.safety) !== common.canonical({ readOnly: true, signing: false, broadcast: false, mutation: false, funds: false, rawPersistence: false, canonicalOutputBoundary: "EXT4_ONLY" })
    || !/^[0-9a-f]{64}$/.test(review.reviewBytesCommitment || "") || review.reviewBytesCommitment !== reviewBytesCommitment(review)
    || !/^[0-9a-f]{64}$/.test(review.reviewerCommitment || "") || review.reviewerCommitment !== commitment(review) || data.length > common.CAPS.reviewBytes) common.fail("INVALID_REVIEWS");
  return { review, bytes: data, byteSha256: common.sha256(data) };
}
async function readPair(root, options = {}) {
  const fixed = options.fixed || await fixedAuthority(root, options), nowMs = options.nowMs ?? Date.now(), rows = [];
  for (const slot of ["A", "B"]) { const file = path.join(root, "reviews", `review-${slot.toLowerCase()}.json`), bytes = (await common.secureRead(file, { ...(options.secureReadOptions||fixed.secureReadOptions||{}),uid: options.uid, cap: common.CAPS.reviewBytes })).bytes; rows.push(validateReview(common.parseCanonicalJson(bytes, common.CAPS.reviewBytes), bytes, fixed, slot, nowMs, options.requireFresh !== false)); }
  if (rows[0].review.reviewerIdentity === rows[1].review.reviewerIdentity || rows[0].review.reviewerRole === rows[1].review.reviewerRole
    || rows[0].review.reviewerCommitment === rows[1].review.reviewerCommitment || rows[0].byteSha256 === rows[1].byteSha256) common.fail("INVALID_REVIEWS"); return { fixed, rows, validatedAt: new Date(nowMs).toISOString() };
}
async function readStdin(limit = 131072) { const chunks = []; let size = 0; for await (const chunk of process.stdin) { size += chunk.length; if (size > limit) common.fail("INVALID_REVIEWS"); chunks.push(chunk); } if (!size) common.fail("INVALID_REVIEWS"); return Buffer.concat(chunks, size); }
async function stageReview(bytes, options = {}) {
  const root = options.root || pkg.ROOT; if (process.platform !== "linux" || root.startsWith("/mnt/c/")) common.fail("LINUX_REQUIRED"); if (!options.skipStartup) common.assertCleanStartup(); const user = common.verifiedUser(options); common.assertRuntimeMount(root, path.join(root, "lifecycle"), process.execPath, user.uid, { ...options, home: user.home }); const fixed = await fixedAuthority(root, { ...options, uid: user.uid }), review = common.parseCanonicalJson(bytes, common.CAPS.reviewBytes), slot = review?.slot;
  if (!Object.hasOwn(ROLES, slot)) common.fail("INVALID_REVIEWS"); validateReview(review, bytes, fixed, slot, options.nowMs ?? Date.now(), true);
  const target = path.join(root, "reviews", `review-${slot.toLowerCase()}.json`), result = await common.durableCreate(target, bytes, { token: `review-${slot.toLowerCase()}` }); common.requireDurable(result); return { slot, sha256: common.sha256(bytes) };
}
async function main(argv = process.argv.slice(2)) { if (argv.length || process.stdin.isTTY) common.fail("ARGUMENTS_FORBIDDEN"); await stageReview(await readStdin()); process.stdout.write(`${PASS}\n`); }
module.exports = { PASS, FAIL, ROLES, IDENTITIES, KEYS, BROKER_CONTRACT, reviewBytesCommitment, commitment, fixedAuthority, validateReview, readPair, readStdin, stageReview, main };
if (require.main === module) main().catch(() => { process.stdout.write(`${FAIL}\n`); process.exitCode = 1; });
