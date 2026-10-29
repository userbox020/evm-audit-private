#!/usr/bin/env node
"use strict";

const v11 = require("./run-profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11.js");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const NAMESPACE = "profitable-async-liability-solidity-builder-host-mount-comparator-v13";
const STATUS = "SEALED_OFFLINE_COMPARATOR_REVIEW_REQUIRED_NO_EXECUTION_AUTHORITY";
const RESERVED_FLAG = "--execute-v13";

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function exactKeys(value, keys, code = "PACKAGE_INVALID") {
  if (!object(value) || JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) throw new Error(code);
}
function equal(actual, expected, code = "PACKAGE_INVALID") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(code);
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function aggregate(paths) { return sha256(Buffer.from(paths.join("\n"))); }
function recordFor(workspace, relative) {
  const bytes = fs.readFileSync(path.join(workspace, ...relative.split("/")));
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
}

const GROUP_KEYS = Object.freeze(["successorRecords", "v12PackageAuthorityRecords", "v12AuthorityChainRecords", "v12TerminalRecords", "v11PackageRecords", "v11FlattenedPredecessorRecords"]);
const GROUP_COUNTS = Object.freeze([4, 3, 9, 3, 7, 121]);
const SUCCESSOR_PATHS = Object.freeze([
  `tools/run-${NAMESPACE}.js`, `tools/test-run-${NAMESPACE}.js`,
  `tools/vendor/${NAMESPACE}/planned-successor-policy.json`, `reports/${NAMESPACE}.md`
]);
const V12_PACKAGE_PATHS = Object.freeze([
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1/manifests/package-manifest.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1/manifests/authority-manifest.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1/manifests/authority-manifest.sha256"
]);
const V12_CHAIN_PATHS = Object.freeze([
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1-execution-authorization/execution-authorization.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1-execution-authorization/authority-manifest.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1-execution-authorization/authority-manifest.sha256",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1-review-decision/review-decision.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1-review-decision/authority-manifest.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1-review-decision/authority-manifest.sha256",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1-final-authority/final-execution-authority.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1-final-authority/authority-manifest.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1-final-authority/authority-manifest.sha256"
]);
const V12_TERMINAL_PATHS = Object.freeze([
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1/runs/71dbbb699f6b610b36f82e94ae2eb07f/authorization-consumed.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1/runs/71dbbb699f6b610b36f82e94ae2eb07f/journal.jsonl",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1/runs/71dbbb699f6b610b36f82e94ae2eb07f/failure.json"
]);
const V11_PACKAGE_PATHS = Object.freeze([
  "tools/run-profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11.js",
  "tools/test-run-profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11.js",
  "reports/profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11.md",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11/planned-successor-policy.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11/manifests/package-manifest.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11/manifests/authority-manifest.json",
  "tools/vendor/profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11/manifests/authority-manifest.sha256"
]);
const MANIFEST_KEYS = Object.freeze(["schema", "namespace", "status", "executionAuthorized", "capabilities", "correction", "diagnosis", "excludedRecords", ...GROUP_KEYS, "v11FlattenedPredecessorCount", "v11FlattenedPredecessorPathAggregateSha256", "plannedSuccessorPolicy", "claims"]);
const AUTHORITY_KEYS = Object.freeze(["schema", "namespace", "status", "executionAuthorized", "reservedFlag", "runner", "tests", "report", "plannedSuccessorPolicy", "packageManifest", "v12AuthorityPackage", "v12Terminal", "v11Package", "capabilities", "claims", "detachedChecksumRole", "v12AuthorityChain"]);
const CAPABILITIES = Object.freeze({ filesystem: false, process: false, network: false, docker: false, inventory: false, dropInExecution: false });
const AUTHORITY_CAPABILITIES = Object.freeze({ filesystem: false, process: false, network: false, docker: false, inventory: false, execution: false, dropInExecution: false });
const CLAIMS = Object.freeze({ exactV12MismatchField: false, hypothesisProven: false, execution: false, reinspect: false, build: false, equality: false, reproducibility: false, parserPromotion: false, detectorRun: false });

function validatePolicy(policy) {
  exactKeys(policy, ["schema", "status", "executionAuthorized", "comparator", "futureExecutor", "dropInExecutionActivation"]);
  if (policy.schema !== `${NAMESPACE}/planned-successor-policy-v1` || policy.status !== "OFFLINE_PLAN_EXECUTION_UNAUTHORIZED" || policy.executionAuthorized !== false || policy.comparator !== "PURE_IN_MEMORY_HOST_MOUNT_SEMANTIC_COMPARATOR" || policy.dropInExecutionActivation !== false) throw new Error("PACKAGE_INVALID");
  exactKeys(policy.futureExecutor, ["distinctReviewedSuccessorRequired", "existingPostCreateInspectOnly", "extraDiagnosticCall", "inventory", "retry", "fallback", "onMismatch"]);
  equal(policy.futureExecutor, { distinctReviewedSuccessorRequired: true, existingPostCreateInspectOnly: true, extraDiagnosticCall: false, inventory: false, retry: false, fallback: false, onMismatch: { exactCausalReceiptRemoval: true, terminalNoRetry: true, persistBoundedComparatorEvidenceOnly: true, allowedEvidenceKeys: ["mismatchCodes", "representationNotes"], persistRawInspect: false, persistRawValues: false } });
}
function validateRecord(record) { exactKeys(record, ["path", "bytes", "sha256"]); if (typeof record.path !== "string" || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("PACKAGE_INVALID"); }
function validatePackageObjects(manifest, authority, policy, detached, source) {
  exactKeys(manifest, MANIFEST_KEYS); exactKeys(authority, AUTHORITY_KEYS); validatePolicy(policy);
  if (manifest.schema !== `${NAMESPACE}/package-manifest-v1` || manifest.namespace !== NAMESPACE || manifest.status !== STATUS || manifest.executionAuthorized !== false) throw new Error("PACKAGE_INVALID");
  equal(manifest.capabilities, CAPABILITIES); equal(manifest.claims, CLAIMS);
  equal(manifest.correction, { onlySemanticDelta: "HOST_CONFIG_MOUNTS_READONLY_OPTIONAL", absentOwnReadOnly: false, ownBooleanAccepted: true, ownNonBoolean: "HOST_MOUNTS_MALFORMED", strictFields: ["Type", "Source", "Target"], ignoredOptionalFields: ["Consistency", "BindOptions"] });
  equal(manifest.diagnosis, { v12AuthorizationId: "71dbbb699f6b610b36f82e94ae2eb07f", createdInspectProcessStatus: 0, mismatchCodes: ["HOST_MOUNTS_MALFORMED"], representationNotes: ["ENV_ORDER_ONLY", "EXTRA_NON_PAL_LABELS_PRESENT"], exactMismatchField: "UNKNOWN_RAW_INSPECT_NOT_RETAINED", strongestCorrectionHypothesis: "HOST_CONFIG_MOUNTS_READONLY_ABSENT_NORMALIZES_FALSE_UNPROVEN", proofOfHypothesis: false });
  equal(manifest.excludedRecords, ["tools/vendor/profitable-async-liability-solidity-builder-semantic-two-build-executor-v12-production-v1/runs/71dbbb699f6b610b36f82e94ae2eb07f/docker-config/config.json", "RAW_DOCKER_INSPECT_NOT_RETAINED"]);
  const fixedPaths = [SUCCESSOR_PATHS, V12_PACKAGE_PATHS, V12_CHAIN_PATHS, V12_TERMINAL_PATHS, V11_PACKAGE_PATHS, source.v11Lineage.map((x) => x.path)];
  GROUP_KEYS.forEach((key, index) => { if (!Array.isArray(manifest[key]) || manifest[key].length !== GROUP_COUNTS[index]) throw new Error("PACKAGE_INVALID"); equal(manifest[key].map((x) => x.path), fixedPaths[index]); manifest[key].forEach(validateRecord); });
  equal(manifest.v12PackageAuthorityRecords, source.v12Package); equal(manifest.v12AuthorityChainRecords, source.v12Chain); equal(manifest.v12TerminalRecords, source.v12Terminal); equal(manifest.v11PackageRecords, source.v11Package); equal(manifest.v11FlattenedPredecessorRecords, source.v11Lineage);
  const all = GROUP_KEYS.flatMap((key) => manifest[key]); if (new Set(all.map((x) => x.path)).size !== all.length) throw new Error("PACKAGE_INVALID");
  if (manifest.v11FlattenedPredecessorCount !== 121 || source.v11Aggregate !== "98e71a8da714e048619a606fb419db3b18e7e7278b5ac4451d6e8995d8bed250" || manifest.v11FlattenedPredecessorPathAggregateSha256 !== source.v11Aggregate || aggregate(manifest.v11FlattenedPredecessorRecords.map((x) => x.path)) !== source.v11Aggregate) throw new Error("PACKAGE_INVALID");
  equal(manifest.plannedSuccessorPolicy, manifest.successorRecords[2]);
  if (authority.schema !== `${NAMESPACE}/authority-v1` || authority.namespace !== NAMESPACE || authority.status !== STATUS || authority.executionAuthorized !== false || authority.reservedFlag !== RESERVED_FLAG || authority.detachedChecksumRole !== "INTEGRITY_ONLY_NOT_EXECUTION_AUTHORITY") throw new Error("PACKAGE_INVALID");
  equal(authority.capabilities, AUTHORITY_CAPABILITIES); equal(authority.claims, CLAIMS);
  [authority.runner, authority.tests, authority.plannedSuccessorPolicy, authority.report].forEach(validateRecord); validateRecord(authority.packageManifest);
  equal([authority.runner, authority.tests, authority.plannedSuccessorPolicy, authority.report], manifest.successorRecords);
  equal(authority.v12AuthorityPackage, manifest.v12PackageAuthorityRecords); equal(authority.v12AuthorityChain, manifest.v12AuthorityChainRecords); equal(authority.v12Terminal, manifest.v12TerminalRecords); equal(authority.v11Package, manifest.v11PackageRecords);
  if (authority.packageManifest.path !== `tools/vendor/${NAMESPACE}/manifests/package-manifest.json`) throw new Error("PACKAGE_INVALID");
  if (detached !== `${source.authoritySha256}  authority-manifest.json\n`) throw new Error("PACKAGE_INVALID");
  return true;
}
function validatePackage(workspace = path.join(__dirname, "..")) {
  const root = path.join(workspace, "tools", "vendor", NAMESPACE), manifests = path.join(root, "manifests");
  equal(fs.readdirSync(root).sort(), ["manifests", "planned-successor-policy.json"]); equal(fs.readdirSync(manifests).sort(), ["authority-manifest.json", "authority-manifest.sha256", "package-manifest.json"]);
  const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(workspace, ...relative.split("/"))));
  const packagePath = `tools/vendor/${NAMESPACE}/manifests/package-manifest.json`, authorityPath = `tools/vendor/${NAMESPACE}/manifests/authority-manifest.json`, policyPath = `tools/vendor/${NAMESPACE}/planned-successor-policy.json`;
  const manifest = readJson(packagePath), authorityBytes = fs.readFileSync(path.join(workspace, ...authorityPath.split("/"))), authority = JSON.parse(authorityBytes), policy = readJson(policyPath);
  const v11Manifest = readJson(V11_PACKAGE_PATHS[4]);
  const source = { v12Package: V12_PACKAGE_PATHS.map((x) => recordFor(workspace, x)), v12Chain: V12_CHAIN_PATHS.map((x) => recordFor(workspace, x)), v12Terminal: V12_TERMINAL_PATHS.map((x) => recordFor(workspace, x)), v11Package: V11_PACKAGE_PATHS.map((x) => recordFor(workspace, x)), v11Lineage: v11Manifest.flattenedPredecessorRecords, v11Aggregate: v11Manifest.flattenedPredecessorPathAggregateSha256, authoritySha256: sha256(authorityBytes) };
  validatePackageObjects(manifest, authority, policy, fs.readFileSync(path.join(manifests, "authority-manifest.sha256"), "utf8"), source);
  for (const item of GROUP_KEYS.flatMap((key) => manifest[key])) equal(item, recordFor(workspace, item.path)); equal(authority.packageManifest, recordFor(workspace, packagePath));
  return Object.freeze({ manifest, authority, policy });
}

// Docker may omit HostConfig.Mounts[*].ReadOnly for a writable bind. V11 required
// the property to be present. Normalize only that absent own property; all other
// validation and comparison behavior remains the sealed V11 implementation.
function normalizeHostMountReadOnly(raw) {
  if (!object(raw) || !object(raw.HostConfig) || !Array.isArray(raw.HostConfig.Mounts)) return raw;
  let changed = false;
  const mounts = raw.HostConfig.Mounts.map((item) => {
    if (!object(item) || own(item, "ReadOnly")) return item;
    changed = true;
    return { ...item, ReadOnly: false };
  });
  if (!changed) return raw;
  return { ...raw, HostConfig: { ...raw.HostConfig, Mounts: mounts } };
}

function compareInspect(raw, expected) {
  return v11.compareInspect(normalizeHostMountReadOnly(raw), expected);
}

function main(argv) {
  if (!Array.isArray(argv)) throw new Error("ARGUMENTS_REJECTED");
  if (argv.length === 0) { validatePackage(); return { schema: `${NAMESPACE}/offline-summary-v1`, status: "PASS", packageStatus: STATUS, executionAuthorized: false, processCalls: 0, writes: 0 }; }
  if (argv.length === 1 && argv[0] === RESERVED_FLAG) throw new Error("V13_NO_EXECUTION_AUTHORITY");
  throw new Error("ARGUMENTS_REJECTED");
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: error.message, executionAuthorized: false, processCalls: 0, writes: 0 })}\n`); process.exitCode = 1; }
}

module.exports = Object.freeze({
  NAMESPACE,
  STATUS,
  RESERVED_FLAG,
  MISMATCH_CODES: v11.MISMATCH_CODES,
  REPRESENTATION_NOTES: v11.REPRESENTATION_NOTES,
  GROUP_KEYS,
  GROUP_COUNTS,
  compareInspect,
  validatePolicy,
  validatePackageObjects,
  validatePackage,
  aggregate,
  main
});
