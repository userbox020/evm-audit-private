#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = path.resolve(__dirname, "..");
const NAMESPACE = "profitable-async-liability-solidity-builder-quarantined-output-diagnostic-v17";
const STATUS = "SEALED_READ_ONLY_QUARANTINED_OUTPUT_DIAGNOSTIC";
const DIAGNOSE_FLAG = "--diagnose-quarantined-v16-output";
const EXACT_COMMAND = `node tools/run-${NAMESPACE}.js ${DIAGNOSE_FLAG}`;
const PACKAGE_REL = `tools/vendor/${NAMESPACE}`;
const V16 = "profitable-async-liability-solidity-builder-exit-validated-two-build-executor-v16-production-v1";
const RUN_ID = "3f979d5654c4c6ae9c565952e0d7546f";
const RUN_REL = `tools/vendor/${V16}/runs/${RUN_ID}`;
const OUT_A_REL = `${RUN_REL}/out-a`;
const OUT_B_REL = `${RUN_REL}/out-b`;
const OUTPUT_NAME = "tree-sitter-solidity.wasm";
const ARTIFACT_REL = `${OUT_A_REL}/${OUTPUT_NAME}`;
const EXPECTED = Object.freeze({ bytes: 508582, sha256: "07420813d7668445152a5d5d2017e0fb84cb27342257e1add3cc7462eec7f811" });
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const DIAGNOSTIC_CODES = Object.freeze({
  MATCH: "MATCHES_SEALED_EXPECTED_VALID_WASM",
  SIZE_MISMATCH: "OBSERVED_BYTES_MISMATCH",
  HASH_MISMATCH: "OBSERVED_SHA256_MISMATCH",
  HEADER_INVALID: "WASM_HEADER_INVALID",
  PATH_UNSAFE: "ARTIFACT_PATH_UNSAFE",
  LISTING_INVALID: "QUARANTINE_LISTING_INVALID",
  READ_FAILED: "ARTIFACT_READ_FAILED",
  CHANGED: "ARTIFACT_CHANGED_DURING_READ",
  TOO_LARGE: "ARTIFACT_TOO_LARGE"
});

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function exactKeys(value, keys, code = "PACKAGE_INVALID") {
  assert.equal(value && typeof value === "object" && !Array.isArray(value), true, code);
  assert.deepEqual(Object.keys(value), keys, code);
}
function contained(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function nativeRealpath(fsImpl, target) {
  return fsImpl.realpathSync.native ? fsImpl.realpathSync.native(target) : fsImpl.realpathSync(target);
}
function safePath(relative, workspace = WORKSPACE, fsImpl = fs, kind = null) {
  assert.equal(typeof relative, "string", "PATH_UNSAFE");
  assert.match(relative, /^(?:\.|[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)$/, "PATH_UNSAFE");
  const root = path.resolve(workspace);
  const absolute = relative === "." ? root : path.resolve(root, ...relative.split("/"));
  assert.equal(contained(absolute, root), true, "PATH_UNSAFE");
  let cursor = root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (const part of [null, ...parts]) {
    if (part !== null) cursor = path.join(cursor, part);
    const stat = fsImpl.lstatSync(cursor);
    assert.equal(stat.isSymbolicLink(), false, "PATH_UNSAFE");
    const real = path.resolve(nativeRealpath(fsImpl, cursor));
    assert.equal(real, path.resolve(cursor), "PATH_UNSAFE");
    assert.equal(contained(real, root), true, "PATH_UNSAFE");
  }
  if (kind) {
    const stat = fsImpl.lstatSync(absolute);
    assert.equal(kind === "file" ? stat.isFile() : stat.isDirectory(), true, "PATH_UNSAFE");
  }
  return absolute;
}
function fileRecord(relative, workspace = WORKSPACE, fsImpl = fs) {
  const bytes = fsImpl.readFileSync(safePath(relative, workspace, fsImpl, "file"));
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
}
function verifyRecord(record, workspace = WORKSPACE, fsImpl = fs) {
  exactKeys(record, ["path", "bytes", "sha256"]);
  assert.match(record.sha256, /^[0-9a-f]{64}$/, "PACKAGE_INVALID");
  assert.equal(Number.isSafeInteger(record.bytes) && record.bytes >= 0, true, "PACKAGE_INVALID");
  assert.deepEqual(fileRecord(record.path, workspace, fsImpl), record, `SEAL:${record.path}`);
}
function readDetached(relative, workspace, fsImpl) {
  const bytes = fsImpl.readFileSync(safePath(relative, workspace, fsImpl, "file"));
  const match = /^([0-9a-f]{64})  authority-manifest\.json\n$/.exec(bytes.toString("utf8"));
  assert.ok(match, "PACKAGE_INVALID");
  return { authoritySha256: match[1], bytes: bytes.length, sha256: sha256(bytes) };
}
function validateTerminalBindings(manifest, workspace, fsImpl) {
  const consumed = JSON.parse(fsImpl.readFileSync(safePath(manifest.v16TerminalRecords[0].path, workspace, fsImpl, "file")));
  exactKeys(consumed, ["schema", "status", "authorizationId", "oneShot", "chain"]);
  assert.equal(consumed.schema, `${V16}/authorization-consumed-v2`);
  assert.equal(consumed.status, "CONSUMED");
  assert.equal(consumed.authorizationId, RUN_ID);
  assert.equal(consumed.oneShot, true);
  const chain = ["executionAuthorization", "reviewDecision", "finalAuthority"].flatMap((key) => [consumed.chain[key].payload, consumed.chain[key].wrapper, consumed.chain[key].detached]);
  assert.deepEqual(chain.map((record, index) => ({ ...record, path: manifest.v16AuthorityChainRecords[index].path })), manifest.v16AuthorityChainRecords);

  const journalBytes = fsImpl.readFileSync(safePath(manifest.v16TerminalRecords[1].path, workspace, fsImpl, "file"));
  const lines = journalBytes.toString("utf8").split("\n");
  assert.equal(lines.pop(), "", "V16_TERMINAL_INVALID");
  const journal = lines.map(JSON.parse);
  assert.equal(journal.length, 18, "V16_TERMINAL_INVALID");
  journal.forEach((row, index) => assert.equal(row.sequence, index, "V16_TERMINAL_INVALID"));
  assert.deepEqual(journal.filter((row) => row.phase === "before").map((row) => row.operation), ["VERSION", "INFO", "IMAGE_INSPECT", "A_CREATE", "A_CREATED_INSPECT", "A_START_ATTACH", "A_EXITED_INSPECT", "A_RM_FORCE"]);
  assert.equal(journal.filter((row) => row.phase === "after").every((row) => row.result.status === 0), true, "V16_TERMINAL_INVALID");

  const failure = JSON.parse(fsImpl.readFileSync(safePath(manifest.v16TerminalRecords[2].path, workspace, fsImpl, "file")));
  assert.equal(failure.schema, `${V16}/failure-v4`, "V16_TERMINAL_INVALID");
  assert.equal(failure.status, "FAIL", "V16_TERMINAL_INVALID");
  assert.equal(failure.authorizationId, RUN_ID, "V16_TERMINAL_INVALID");
  assert.equal(failure.executionAuthorized, true, "V16_TERMINAL_INVALID");
  assert.equal(failure.consumed, true, "V16_TERMINAL_INVALID");
  assert.equal(failure.processCalls, 8, "V16_TERMINAL_INVALID");
  assert.equal(failure.terminalEvidenceState, "PERSISTED_FAILURE_JOURNAL_VERIFIED", "V16_TERMINAL_INVALID");
  assert.equal(failure.value.rootCauseCode, "OUTPUT_INVALID", "V16_TERMINAL_INVALID");
  assert.equal(failure.value.noRetry, true, "V16_TERMINAL_INVALID");
  assert.deepEqual(failure.consumption, { path: "authorization-consumed.json", bytes: manifest.v16TerminalRecords[0].bytes, sha256: manifest.v16TerminalRecords[0].sha256, parentFsync: "PERSISTED_READBACK_PARENT_FSYNC_LIMITED" });
  assert.equal(failure.journal.bytes, manifest.v16TerminalRecords[1].bytes, "V16_TERMINAL_INVALID");
  assert.equal(failure.journal.sha256, manifest.v16TerminalRecords[1].sha256, "V16_TERMINAL_INVALID");
}
function validateSealedPackage(workspace, fsImpl) {
  const root = safePath(PACKAGE_REL, workspace, fsImpl, "directory");
  assert.deepEqual(fsImpl.readdirSync(root).sort(), ["diagnostic-policy.json", "manifests"], "PACKAGE_INVALID");
  const manifestsRoot = safePath(`${PACKAGE_REL}/manifests`, workspace, fsImpl, "directory");
  assert.deepEqual(fsImpl.readdirSync(manifestsRoot).sort(), ["authority-manifest.json", "authority-manifest.sha256", "package-manifest.json"], "PACKAGE_INVALID");
  const manifestRel = `${PACKAGE_REL}/manifests/package-manifest.json`;
  const authorityRel = `${PACKAGE_REL}/manifests/authority-manifest.json`;
  const detachedRel = `${PACKAGE_REL}/manifests/authority-manifest.sha256`;
  const manifest = JSON.parse(fsImpl.readFileSync(safePath(manifestRel, workspace, fsImpl, "file")));
  exactKeys(manifest, ["schema", "namespace", "status", "executionAuthorized", "diagnosticFlag", "exactArtifactPath", "expected", "limits", "successorRecords", "v16TerminalRecords", "v16AuthorityChainRecords", "v16PackageRecords"]);
  assert.equal(manifest.schema, `${NAMESPACE}/package-manifest-v1`);
  assert.equal(manifest.namespace, NAMESPACE);
  assert.equal(manifest.status, STATUS);
  assert.equal(manifest.executionAuthorized, false);
  assert.equal(manifest.diagnosticFlag, DIAGNOSE_FLAG);
  assert.equal(manifest.exactArtifactPath, ARTIFACT_REL);
  assert.deepEqual(manifest.expected, EXPECTED);
  assert.deepEqual(manifest.limits, { maximumArtifactBytes: MAX_ARTIFACT_BYTES, chunkBytes: CHUNK_BYTES, artifactReads: 1, processCalls: 0, writes: 0, networkCalls: 0 });
  for (const records of [manifest.v16TerminalRecords, manifest.v16AuthorityChainRecords, manifest.v16PackageRecords, manifest.successorRecords]) for (const record of records) verifyRecord(record, workspace, fsImpl);
  validateTerminalBindings(manifest, workspace, fsImpl);
  const policy = JSON.parse(fsImpl.readFileSync(safePath(`${PACKAGE_REL}/diagnostic-policy.json`, workspace, fsImpl, "file")));
  exactKeys(policy, ["schema", "namespace", "status", "executionAuthorized", "fixedV16RunId", "diagnosticFlag", "readOnly", "productionSurface", "pathBinding", "noFollowFallback", "artifactReads", "maximumArtifactBytes", "chunkBytes", "processCalls", "writes", "networkCalls", "claims"]);
  assert.equal(policy.schema, `${NAMESPACE}/diagnostic-policy-v1`);
  assert.equal(policy.namespace, NAMESPACE);
  assert.equal(policy.status, STATUS);
  assert.equal(policy.executionAuthorized, false);
  assert.equal(policy.fixedV16RunId, RUN_ID);
  assert.equal(policy.diagnosticFlag, DIAGNOSE_FLAG);
  assert.equal(policy.readOnly, true);
  assert.equal(policy.productionSurface, "FIXED_CONSTANTS_NO_INJECTION");
  assert.equal(policy.pathBinding, "PARENTS_AND_FINAL_PREOPEN_POSTOPEN_POSTREAD");
  assert.equal(policy.noFollowFallback, "RELIABLE_NONZERO_DEV_INO_REQUIRED");
  assert.deepEqual({ artifactReads: policy.artifactReads, maximumArtifactBytes: policy.maximumArtifactBytes, chunkBytes: policy.chunkBytes, processCalls: policy.processCalls, writes: policy.writes, networkCalls: policy.networkCalls }, { artifactReads: 1, maximumArtifactBytes: MAX_ARTIFACT_BYTES, chunkBytes: CHUNK_BYTES, processCalls: 0, writes: 0, networkCalls: 0 });
  assert.deepEqual(policy.claims, { execution: false, build: false, retry: false, equalityResult: false, reproducibility: false, parserPromotion: false, detectorRun: false });

  const authorityBytes = fsImpl.readFileSync(safePath(authorityRel, workspace, fsImpl, "file"));
  const detached = readDetached(detachedRel, workspace, fsImpl);
  assert.equal(sha256(authorityBytes), detached.authoritySha256, "PACKAGE_INVALID");
  const authority = JSON.parse(authorityBytes);
  exactKeys(authority, ["schema", "namespace", "status", "executionAuthorized", "runner", "tests", "report", "policy", "packageManifest", "v16RunId", "v16TerminalRecords", "v16AuthorityChainRecords", "v16PackageRecords", "claims", "detachedChecksumRole"]);
  assert.equal(authority.schema, `${NAMESPACE}/authority-v1`);
  assert.equal(authority.namespace, NAMESPACE);
  assert.equal(authority.status, STATUS);
  assert.equal(authority.executionAuthorized, false);
  const roleNames = ["runner", "tests", "report", "policy"];
  roleNames.forEach((role, index) => assert.deepEqual(authority[role], manifest.successorRecords[index], "PACKAGE_INVALID"));
  assert.deepEqual(authority.packageManifest, fileRecord(manifestRel, workspace, fsImpl));
  assert.equal(authority.v16RunId, RUN_ID);
  assert.deepEqual(authority.v16TerminalRecords, manifest.v16TerminalRecords);
  assert.deepEqual(authority.v16AuthorityChainRecords, manifest.v16AuthorityChainRecords);
  assert.deepEqual(authority.v16PackageRecords, manifest.v16PackageRecords);
  assert.deepEqual(authority.claims, { execution: false, build: false, retry: false, equalityResult: false, reproducibility: false, parserPromotion: false, detectorRun: false });
  assert.equal(authority.detachedChecksumRole, "INTEGRITY_ONLY_NOT_EXECUTION_AUTHORITY");
  return { manifest, authority, packageManifestSha256: authority.packageManifest.sha256, authoritySha256: detached.authoritySha256, detachedSha256: detached.sha256 };
}

function validatePackage() {
  if (arguments.length !== 0) throw new Error("CALLER_DEPENDENCIES_REJECTED");
  return validateSealedPackage(WORKSPACE, fs);
}

function blankResult(code, artifactReads = 0, observedBytes = null) {
  return {
    schema: `${NAMESPACE}/diagnostic-result-v1`, status: "DIAGNOSTIC_INCOMPLETE", artifactReads, processCalls: 0, writes: 0, networkCalls: 0,
    observedBytes, observedSha256: null, expectedBytes: EXPECTED.bytes, expectedSha256: EXPECTED.sha256,
    expectedBytesMatch: observedBytes === null ? null : observedBytes === EXPECTED.bytes, expectedSha256Match: null,
    wasmHeaderValid: null, publishedBytesMatch: observedBytes === null ? null : observedBytes === EXPECTED.bytes, publishedSha256Match: null,
    diagnosticCode: code
  };
}
function statType(stats) {
  if (stats && typeof stats.isFile === "function" && stats.isFile()) return "FILE";
  if (stats && typeof stats.isDirectory === "function" && stats.isDirectory()) return "DIRECTORY";
  return "OTHER";
}
function identity(stats) { return { dev: stats.dev, ino: stats.ino, type: statType(stats) }; }
function reliable(value) { return (typeof value === "number" && Number.isFinite(value) && value !== 0) || (typeof value === "bigint" && value !== 0n); }
function identityReliable(value) { return reliable(value.dev) && reliable(value.ino); }
function sameIdentity(left, right) { return left.type === right.type && left.dev === right.dev && left.ino === right.ino; }
function sameContentMetadata(left, right) {
  return sameIdentity(identity(left), identity(right)) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function capturePathChain(relative, finalType) {
  assert.match(relative, /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/, "PATH_UNSAFE");
  const root = path.resolve(WORKSPACE), absolute = path.resolve(root, ...relative.split("/"));
  assert.equal(contained(absolute, root), true, "PATH_UNSAFE");
  const components = [], parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index <= parts.length; index += 1) {
    if (index > 0) cursor = path.join(cursor, parts[index - 1]);
    const stats = fs.lstatSync(cursor), type = statType(stats), expectedType = index === parts.length ? finalType : "DIRECTORY";
    assert.equal(stats.isSymbolicLink(), false, "PATH_UNSAFE");
    assert.equal(type, expectedType, "PATH_UNSAFE");
    const real = path.resolve(nativeRealpath(fs, cursor));
    assert.equal(real, path.resolve(cursor), "PATH_UNSAFE");
    assert.equal(contained(real, root), true, "PATH_UNSAFE");
    components.push(Object.freeze({ lexical: path.resolve(cursor), real, identity: identity(stats) }));
  }
  return Object.freeze({ absolute, components: Object.freeze(components), final: components[components.length - 1] });
}
function revalidatePathChain(snapshot) {
  try {
    for (const expected of snapshot.components) {
      const stats = fs.lstatSync(expected.lexical);
      if (stats.isSymbolicLink() || !sameIdentity(identity(stats), expected.identity)) return false;
      const real = path.resolve(nativeRealpath(fs, expected.lexical));
      if (real !== expected.real || !contained(real, WORKSPACE)) return false;
    }
    return true;
  } catch { return false; }
}
function exactListings(outA, outB) {
  try { return JSON.stringify(fs.readdirSync(outA).sort()) === JSON.stringify([OUTPUT_NAME]) && fs.readdirSync(outB).length === 0; }
  catch { return false; }
}
function diagnoseFixedArtifact() {
  let outAChain;
  let outBChain;
  try {
    outAChain = capturePathChain(OUT_A_REL, "DIRECTORY");
    outBChain = capturePathChain(OUT_B_REL, "DIRECTORY");
    if (!exactListings(outAChain.absolute, outBChain.absolute)) return blankResult(DIAGNOSTIC_CODES.LISTING_INVALID);
  } catch { return blankResult(DIAGNOSTIC_CODES.LISTING_INVALID); }
  let artifactChain;
  try { artifactChain = capturePathChain(ARTIFACT_REL, "FILE"); }
  catch { return blankResult(DIAGNOSTIC_CODES.PATH_UNSAFE); }
  const noFollowAvailable = typeof fs.constants.O_NOFOLLOW === "number" && fs.constants.O_NOFOLLOW !== 0;
  if (!noFollowAvailable && !artifactChain.components.every((entry) => identityReliable(entry.identity))) return blankResult(DIAGNOSTIC_CODES.PATH_UNSAFE);
  let fd;
  try { fd = fs.openSync(artifactChain.absolute, fs.constants.O_RDONLY | (noFollowAvailable ? fs.constants.O_NOFOLLOW : 0)); }
  catch { return blankResult(DIAGNOSTIC_CODES.READ_FAILED); }
  let before;
  let after;
  let observedBytes = null;
  let observedSha256 = null;
  let wasmHeaderValid = null;
  let readFailure = false;
  let shortRead = false;
  let pathChangedAfterRead = false;
  try {
    try { before = fs.fstatSync(fd); } catch { return blankResult(DIAGNOSTIC_CODES.READ_FAILED, 1); }
    observedBytes = before.size;
    const descriptorIdentity = identity(before);
    if (descriptorIdentity.type !== "FILE" || !sameIdentity(descriptorIdentity, artifactChain.final.identity)) return blankResult(DIAGNOSTIC_CODES.PATH_UNSAFE, 1, Number.isSafeInteger(observedBytes) ? observedBytes : null);
    if (!revalidatePathChain(artifactChain) || !revalidatePathChain(outBChain) || !exactListings(outAChain.absolute, outBChain.absolute)) return blankResult(DIAGNOSTIC_CODES.PATH_UNSAFE, 1, Number.isSafeInteger(observedBytes) ? observedBytes : null);
    if (!Number.isSafeInteger(observedBytes) || observedBytes < 0) return blankResult(DIAGNOSTIC_CODES.READ_FAILED, 1);
    if (observedBytes > MAX_ARTIFACT_BYTES) {
      try { after = fs.fstatSync(fd); } catch { return blankResult(DIAGNOSTIC_CODES.READ_FAILED, 1, observedBytes); }
      pathChangedAfterRead = !revalidatePathChain(artifactChain) || !revalidatePathChain(outBChain) || !exactListings(outAChain.absolute, outBChain.absolute);
      if (!sameContentMetadata(before, after) || pathChangedAfterRead) return blankResult(DIAGNOSTIC_CODES.CHANGED, 1, observedBytes);
      return blankResult(DIAGNOSTIC_CODES.TOO_LARGE, 1, observedBytes);
    }
    const hash = crypto.createHash("sha256"), chunk = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(observedBytes, 1))), header = Buffer.alloc(Math.min(8, observedBytes));
    let offset = 0;
    while (offset < observedBytes) {
      const wanted = Math.min(chunk.length, observedBytes - offset);
      let count;
      try { count = fs.readSync(fd, chunk, 0, wanted, offset); } catch { readFailure = true; break; }
      if (!Number.isSafeInteger(count) || count < 0 || count > wanted) { readFailure = true; break; }
      if (count === 0) { shortRead = true; break; }
      if (offset < 8) chunk.copy(header, offset, 0, Math.min(count, 8 - offset));
      hash.update(chunk.subarray(0, count)); offset += count;
    }
    try { after = fs.fstatSync(fd); } catch { readFailure = true; }
    pathChangedAfterRead = !revalidatePathChain(artifactChain) || !revalidatePathChain(outBChain) || !exactListings(outAChain.absolute, outBChain.absolute);
    if (!readFailure && !shortRead && offset === observedBytes && !pathChangedAfterRead) {
      observedSha256 = hash.digest("hex"); wasmHeaderValid = header.length === 8 && header.equals(WASM_HEADER);
    }
  } finally {
    try { fs.closeSync(fd); } catch { readFailure = true; }
  }
  if (pathChangedAfterRead || shortRead || (before && after && !sameContentMetadata(before, after))) return blankResult(DIAGNOSTIC_CODES.CHANGED, 1, observedBytes);
  if (readFailure || observedSha256 === null) return blankResult(DIAGNOSTIC_CODES.READ_FAILED, 1, observedBytes);
  const expectedBytesMatch = observedBytes === EXPECTED.bytes;
  const expectedSha256Match = observedSha256 === EXPECTED.sha256;
  let diagnosticCode = DIAGNOSTIC_CODES.MATCH;
  if (!wasmHeaderValid) diagnosticCode = DIAGNOSTIC_CODES.HEADER_INVALID;
  else if (!expectedBytesMatch) diagnosticCode = DIAGNOSTIC_CODES.SIZE_MISMATCH;
  else if (!expectedSha256Match) diagnosticCode = DIAGNOSTIC_CODES.HASH_MISMATCH;
  return {
    schema: `${NAMESPACE}/diagnostic-result-v1`, status: diagnosticCode === DIAGNOSTIC_CODES.MATCH ? "DIAGNOSTIC_MATCH" : "DIAGNOSTIC_MISMATCH",
    artifactReads: 1, processCalls: 0, writes: 0, networkCalls: 0,
    observedBytes, observedSha256, expectedBytes: EXPECTED.bytes, expectedSha256: EXPECTED.sha256,
    expectedBytesMatch, expectedSha256Match, wasmHeaderValid,
    publishedBytesMatch: expectedBytesMatch, publishedSha256Match: expectedSha256Match, diagnosticCode
  };
}
function defaultSummary(base) {
  return {
    schema: `${NAMESPACE}/offline-summary-v1`, status: "PASS", packageStatus: STATUS, executionAuthorized: false,
    artifactReads: 0, processCalls: 0, writes: 0, networkCalls: 0,
    packageManifestSha256: base.packageManifestSha256, authoritySha256: base.authoritySha256, detachedSha256: base.detachedSha256
  };
}
function orchestrate(argv) {
  if (!Array.isArray(argv)) throw new Error("ARGUMENTS_REJECTED");
  if (argv.length !== 0 && (argv.length !== 1 || argv[0] !== DIAGNOSE_FLAG)) throw new Error("ARGUMENTS_REJECTED");
  const base = validateSealedPackage(WORKSPACE, fs);
  if (argv.length === 0) return defaultSummary(base);
  return diagnoseFixedArtifact();
}
function main(argv) {
  if (arguments.length !== 1) throw new Error("CALLER_DEPENDENCIES_REJECTED");
  return orchestrate(argv);
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: error.message, artifactReads: 0, processCalls: 0, writes: 0, networkCalls: 0 })}\n`); process.exitCode = 1; }
}
module.exports = Object.freeze({ NAMESPACE, STATUS, DIAGNOSE_FLAG, EXACT_COMMAND, EXPECTED, DIAGNOSTIC_CODES, validatePackage, main });
