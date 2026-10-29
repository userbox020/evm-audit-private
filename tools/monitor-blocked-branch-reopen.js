#!/usr/bin/env node
"use strict";

// Offline-only prerequisite monitor. The workspace and its parent directories
// are assumed to be trusted against concurrent administrator-level mutation.
// Identity/realpath checks close ordinary symlink, reparse, replacement, and
// race hazards, but cannot promise safety against a hostile local administrator.
// Node cannot independently inspect every Windows cloud-recall/tiering attribute;
// REOPEN_CANDIDATE therefore also requires a fresh reviewer-approved attestation
// that this evidence root is fully local, non-tiered, and free of generic reparse
// points. The attestation supplements and never weakens the checks below.
// This module has no network, signing, transaction, fork, runner, child-process,
// or package-manager integration.
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "blocked-branch-reopen-state/v1";
const EVIDENCE_ROOT = "coordination/reopen-evidence";
const DEFAULT_OUTPUT = "reports/monitor/blocked-branch-reopen-state.json";
const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86400;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 15 * 60 * 1000;
const MAX_STAGING_SCAN = 16;
const MAX_CLI_CHARS = 8192;
const MAX_PATH_CHARS = 512;
const MAX_SEGMENT_CHARS = 96;
const MAX_DESCRIPTOR_ARRAY_COUNT = 16;
const MAX_DESCRIPTORS_PER_BRANCH = 48;
const MAX_DESCRIPTORS_PER_CYCLE = 51;
const MAX_CYCLE_READ_BYTES = 32 * 1024 * 1024;
const MAX_POSITIONAL_READ_BYTES = 64 * 1024;
const REPARSE_POINT = 0x400;
const ADVISORY = "candidate only; coordinator/reviewer approval still required";
const HISTORICAL_ADVISORY = "historical only; not a current reopen candidate";
const BRANCHES = ["renzo", "fraxlend", "uniswapx", "valantis"];
const HASH = /^[0-9a-f]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const PROTECTED_EVIDENCE_NAME = /^(?:rpc_endpoints\.txt|graphql_endpoints\.txt|hyperevm_archive_endpoints\.md|base_full_stack_endpoints\.md|wallets?|keys?|keystores?)(?:\..*)?$|(?:^|[-_.])(?:private[-_]?key|keypair|wallet)(?:[-_.]|$)|\.(?:pem|key|p12|pfx)$/i;

const CONSUMED_RENZO_HASHES = new Set([
  "55de363060f194a2b7102dea9cce21f82c5e19692317287b77205a4c9e67da9f",
  "9879b38f5995a67cdefc65785dec57e924c33a563db1a337e3b81b51abc357ae",
  "bbc213beb5c199f2e8f5e06194440c6303c9efd1ca9fb8bdf72eede8656728de",
  "52b87401b24ebc508e117c314be76acbbba05fa313439bb708de0a833c705326",
  "3a17728444e90b90d495bf9be4f7794b4f3d631bcc9cc53ff25a7bb4ee1ace65",
]);
const CONSUMED_UNISWAPX_HASHES = new Set([
  "0030b2f1e287515c52aaaea90463ff845524b8b75727da602d1018e5169f9425",
  "01fe1cd19d6142ba85ffeb5974123d4c1cdf80f6e382e5f477c62294f95f3fd1",
  "ea4742232d9d0664622a4d0be4bd49296aa9ec77a1e9f929705591935c56c268",
  "53a6e0ce45fd07350220a1366c77457e1c1b3a6ed53d9ab3442f7b30ea14051b",
  "2de74ba6f4b467b6a45b735dd2feebc69181450b481ad5c520469d9d6ba66adf",
  "3d60111b71621f30067d5270275439d885a3abc39cbf2a9a628e6a9d77c7846a",
]);
const VALANTIS_PREDECESSOR = Object.freeze({
  diagnostic: "3e73b97bb2d4979d79de8c884745f2664f8e92efa0cc27aa3f0d71ed46e807ea",
  runner: "8317b758375c8198c7b94cfdc5241cffe59b5409211759b3b8f913647c1eea27",
  authority: "45fae986fb28ce5cca74c479d31b3ec868a0781722d7549dc30f1baf06817aef",
  package: "8111f8b0d4d1a882d7b166461567d0051efdd870e70c77e7619dc33e2d3517b3",
});
const CONSUMED_VALANTIS_HASHES = new Set([
  // Step2
  "9eef34e3a2635ce32c9c91ee6aedd74a9337c8536ead22555ce54f0da3864c90",
  "f35f85233daed6514dd38a88d572bd80edacfa94c6c6c1cea33c56ed4fdd7ae4",
  "92d8b9ff85e6db7a8c48cc0d28d12cfc98ef0681f0fb590288116d0a97ae78a9",
  "ae054a7a75ddd4b2bcc7b6f9f8511511fc9773bc9aa98cd61116001c7da7d541",
  "8459231294312344e14220b0979fbaebbaf07db4587b2021e6696efb6acc0ba2",
  // Step2S
  VALANTIS_PREDECESSOR.runner,
  "80a60ee349c3cc2387183a2e02ff5ee8d8030d458ad3baaddc7df498b4eacd68",
  VALANTIS_PREDECESSOR.authority,
  VALANTIS_PREDECESSOR.package,
  VALANTIS_PREDECESSOR.diagnostic,
  // Step2R
  "20b3698564eed184d418cdbe505d177abb07d4154295c253650fc28ed209568e",
  "087b6a95cafd193ecbb5720767154fc532926e815bba05b3dce3445ebcb9d195",
  "b449b1655a079cbaab7dd1bc81936c8d3634cbbae3af2b4550d17d38e6b9ad3d",
  "3ce6d92eb0b0108153cbda2a97a9ebeb63b09f609ad18b1e073e0e8320a88c06",
]);

class MonitorError extends Error {
  constructor(code) { super(code); this.code = code; }
}
class ReadBudget {
  constructor(limit = MAX_CYCLE_READ_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CYCLE_READ_BYTES) fail("READ_BUDGET_INVALID");
    this.limit = limit;
    this.used = 0;
    this.reserved = 0;
  }
  consume(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.used + this.reserved + bytes > this.limit) fail("READ_BUDGET_EXCEEDED");
    this.used += bytes;
  }
  reserve(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.used + this.reserved + bytes > this.limit) fail("READ_BUDGET_EXCEEDED");
    this.reserved += bytes;
    return { active: true, bytes };
  }
  commit(token, verifiedBytes) {
    if (!token?.active || token.bytes !== verifiedBytes) fail("READ_BUDGET_INVALID");
    token.active = false;
    this.reserved -= token.bytes;
    this.used += verifiedBytes;
  }
  cancel(token) {
    if (!token?.active) return;
    token.active = false;
    this.reserved -= token.bytes;
  }
}
function fail(code) { throw new MonitorError(code); }
function object(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function isPlain(value) { return object(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function isReparse(stats) { return Boolean((stats.fileAttributes || 0) & REPARSE_POINT); }
function isoNow(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("TIME_INVALID");
  return date.toISOString();
}
function canonicalJson(value) {
  const active = new WeakSet();
  function encode(item) {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("CANONICAL_VALUE_UNSUPPORTED");
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (active.has(item)) fail("CANONICAL_VALUE_UNSUPPORTED");
      active.add(item);
      const encoded = `[${item.map(encode).join(",")}]`;
      active.delete(item);
      return encoded;
    }
    if (!isPlain(item)) fail("CANONICAL_VALUE_UNSUPPORTED");
    if (active.has(item)) fail("CANONICAL_VALUE_UNSUPPORTED");
    active.add(item);
    const encoded = `{${Object.keys(item).sort().map((key) => {
      if (item[key] === undefined) fail("CANONICAL_VALUE_UNSUPPORTED");
      return `${JSON.stringify(key)}:${encode(item[key])}`;
    }).join(",")}}`;
    active.delete(item);
    return encoded;
  }
  return encode(value);
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function normalizeHash(value) { return typeof value === "string" && HASH.test(value) ? value.toLowerCase() : null; }
function sortedUnique(values) { return [...new Set(values)].sort(); }
function exactKeys(value, keys) {
  return isPlain(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function validId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
function validTime(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function freshTime(value, nowMs) {
  if (!validTime(value)) return false;
  const time = Date.parse(value);
  return time <= nowMs && nowMs - time <= MAX_EVIDENCE_AGE_MS;
}
function add(blockers, condition, code) { if (!condition) blockers.push(code); }

function portableRelative(relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\0") || relative.includes("\\")
    || relative.length > MAX_PATH_CHARS || relative.includes(":") || relative.startsWith("/")
    || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(relative)) fail("PATH_INVALID");
  const segments = relative.split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === ".."
    || segment.length > MAX_SEGMENT_CHARS || /[. ]$/.test(segment) || RESERVED_DEVICE.test(segment)
    || PROTECTED_EVIDENCE_NAME.test(segment)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) fail("PATH_INVALID");
  return segments.join("/");
}
function evidenceRelative(relative) {
  const safe = portableRelative(relative);
  if (safe === EVIDENCE_ROOT || !safe.startsWith(`${EVIDENCE_ROOT}/`)) fail("PATH_OUTSIDE_EVIDENCE_ROOT");
  return safe;
}
function outputRelative(relative) {
  const safe = portableRelative(relative);
  if (safe !== DEFAULT_OUTPUT) fail("OUTPUT_PATH_INVALID");
  return safe;
}
function resolveWithin(root, relative) {
  const safe = portableRelative(relative);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...safe.split("/"));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) fail("PATH_ESCAPE");
  return { safe, resolved, resolvedRoot };
}
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function safeDirectoryStats(stats) { return stats.isDirectory() && !stats.isSymbolicLink() && !isReparse(stats); }
function safeFileStats(stats, maxBytes) {
  return stats.isFile() && !stats.isSymbolicLink() && !isReparse(stats) && stats.nlink === 1 && stats.size <= maxBytes;
}
async function directorySnapshot(root, directory) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(directory);
  const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("PATH_ESCAPE");
  const rows = [];
  let current = resolvedRoot;
  for (const part of [null, ...(relative ? relative.split(path.sep) : [])]) {
    if (part !== null) current = path.join(current, part);
    let stats;
    try { stats = await fsp.lstat(current); } catch { fail("DIRECTORY_UNAVAILABLE"); }
    if (!safeDirectoryStats(stats)) fail("DIRECTORY_UNSAFE");
    let real;
    try { real = await fsp.realpath(current); } catch { fail("DIRECTORY_UNSAFE"); }
    if (path.resolve(real) !== path.resolve(current)) fail("DIRECTORY_UNSAFE");
    rows.push({ path: current, dev: stats.dev, ino: stats.ino });
  }
  return rows;
}
async function revalidateDirectories(snapshot) {
  for (const row of snapshot) {
    let stats;
    try { stats = await fsp.lstat(row.path); } catch { fail("DIRECTORY_CHANGED"); }
    if (!safeDirectoryStats(stats) || stats.dev !== row.dev || stats.ino !== row.ino
      || path.resolve(await fsp.realpath(row.path)) !== path.resolve(row.path)) fail("DIRECTORY_CHANGED");
  }
}
async function readSafeBytes(root, relative, maxBytes, evidenceOnly = true, budget = null, dependencies = {}) {
  const safe = evidenceOnly ? evidenceRelative(relative) : portableRelative(relative);
  const target = resolveWithin(root, safe);
  const directories = await directorySnapshot(root, path.dirname(target.resolved));
  let before;
  try { before = await fsp.lstat(target.resolved); } catch (error) {
    if (error?.code === "ENOENT") fail("INPUT_UNAVAILABLE");
    fail("INPUT_READ_FAILED");
  }
  if (!safeFileStats(before, maxBytes)) fail(before.size > maxBytes ? "INPUT_TOO_LARGE" : "INPUT_UNSAFE");
  if (path.resolve(await fsp.realpath(target.resolved)) !== target.resolved) fail("INPUT_UNSAFE");
  let handle;
  let reservation = null;
  try {
    handle = await fsp.open(target.resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!safeFileStats(opened, maxBytes) || !sameIdentity(before, opened) || opened.size !== before.size) fail("INPUT_CHANGED");
    if (budget) reservation = budget.reserve(opened.size);
    await dependencies.afterReserve?.({ file: target.resolved, size: opened.size });
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const length = Math.min(MAX_POSITIONAL_READ_BYTES, opened.size - offset);
      const result = await handle.read(bytes, offset, length, offset);
      if (result.bytesRead !== length) fail("INPUT_CHANGED");
      offset += result.bytesRead;
    }
    await dependencies.afterExactRead?.({ file: target.resolved, size: opened.size });
    const trailing = Buffer.alloc(1);
    const trailingRead = await handle.read(trailing, 0, 1, opened.size);
    if (trailingRead.bytesRead !== 0) fail("INPUT_TRAILING_DATA");
    const after = await handle.stat();
    if (!safeFileStats(after, maxBytes) || !sameIdentity(opened, after) || after.size !== opened.size || bytes.length !== opened.size) fail("INPUT_CHANGED");
    await revalidateDirectories(directories);
    const final = await fsp.lstat(target.resolved);
    if (!sameIdentity(after, final) || final.size !== opened.size || path.resolve(await fsp.realpath(target.resolved)) !== target.resolved) fail("INPUT_CHANGED");
    if (budget) { budget.commit(reservation, bytes.length); reservation = null; }
    return { bytes, path: safe, sha256: sha256(bytes), identity: { dev: after.dev, ino: after.ino } };
  } finally {
    if (budget && reservation) budget.cancel(reservation);
    if (handle) await handle.close().catch(() => {});
  }
}
async function readSafeJson(root, relative, maxBytes = MAX_INPUT_BYTES, evidenceOnly = true, budget = null) {
  const record = await readSafeBytes(root, relative, maxBytes, evidenceOnly, budget);
  let value;
  try { value = JSON.parse(record.bytes.toString("utf8")); } catch { fail("MALFORMED_JSON"); }
  if (!isPlain(value)) fail("JSON_OBJECT_REQUIRED");
  return { value, path: record.path, sha256: record.sha256 };
}

function descriptorShape(value) { return exactKeys(value, ["path", "sha256"]) && normalizeHash(value.sha256) && (() => { try { evidenceRelative(value.path); return true; } catch { return false; } })(); }
function compilerShape(value) { return exactKeys(value, ["path", "sha256", "exactLocalBinary"]) && value.exactLocalBinary === true && normalizeHash(value.sha256) && (() => { try { evidenceRelative(value.path); return true; } catch { return false; } })(); }
function evidenceView(record) { return { path: record.path, sha256: record.sha256 }; }
function uniquePaths(descriptors, excluded = []) {
  const values = descriptors.map((row) => row.value.path).concat(excluded);
  return new Set(values).size === values.length;
}
async function verifyDescriptors(root, entries, prefix, budget) {
  const records = [];
  const blockers = [];
  for (const entry of entries) {
    try {
      const record = await readSafeBytes(root, entry.value.path, MAX_EVIDENCE_BYTES, true, budget);
      if (record.sha256 !== normalizeHash(entry.value.sha256)) blockers.push(`${prefix}_${entry.name}_HASH_MISMATCH`);
      records.push(record);
    } catch (error) {
      blockers.push(`${prefix}_${entry.name}_${error instanceof MonitorError ? error.code : "INPUT_READ_FAILED"}`);
    }
  }
  return { records, blockers };
}

function validateRenzoLineage(value, nowMs) {
  const blockers = [];
  const top = ["schema", "lineageId", "newLineage", "reviewed", "reviewDecision", "reviewedAt", "observedAt", "artifacts", "consumedStep5Excluded", "importsConsumedRunner"];
  add(blockers, exactKeys(value, top), "RENZO_LINEAGE_EXACT_SCHEMA_INVALID");
  if (!exactKeys(value, top)) return { blockers, descriptors: [] };
  add(blockers, value.schema === "blocked-branch-reopen/renzo-lineage/v2", "RENZO_LINEAGE_SCHEMA_INVALID");
  add(blockers, validId(value.lineageId), "RENZO_LINEAGE_ID_INVALID");
  add(blockers, value.newLineage === true, "RENZO_LINEAGE_NOT_NEW");
  add(blockers, value.reviewed === true, "RENZO_LINEAGE_NOT_REVIEWED");
  add(blockers, value.reviewDecision === "APPROVED_CANDIDATE", "RENZO_REVIEW_DECISION_INVALID");
  add(blockers, freshTime(value.reviewedAt, nowMs), "RENZO_REVIEW_TIME_NOT_FRESH");
  add(blockers, freshTime(value.observedAt, nowMs), "RENZO_OBSERVATION_NOT_FRESH");
  add(blockers, value.consumedStep5Excluded === true, "RENZO_CONSUMED_STEP5_EXCLUSION_MISSING");
  add(blockers, value.importsConsumedRunner === false, "RENZO_CONSUMED_RUNNER_IMPORT_REJECTED");
  add(blockers, exactKeys(value.artifacts, ["runner", "test", "package", "approval"]), "RENZO_ARTIFACTS_EXACT_SCHEMA_INVALID");
  if (!exactKeys(value.artifacts, ["runner", "test", "package", "approval"])) return { blockers, descriptors: [] };
  const descriptors = Object.entries(value.artifacts).map(([name, item]) => ({ name: name.toUpperCase(), value: item }));
  for (const row of descriptors) add(blockers, descriptorShape(row.value), `RENZO_${row.name}_DESCRIPTOR_INVALID`);
  return { blockers: sortedUnique(blockers), descriptors: blockers.some((x) => x.endsWith("DESCRIPTOR_INVALID")) ? [] : descriptors };
}
function validateRenzoQualification(value, nowMs) {
  const blockers = [];
  const top = ["schema", "lineageId", "observedAt", "success", "sanitized", "providerMaterialAbsent", "groupCount", "distinctGroups", "identicalFinalizedHeader", "finalizedHeader", "sourceLineageDigest", "output", "approval", "outputSha256", "approvalSha256", "retry"];
  add(blockers, exactKeys(value, top), "RENZO_QUALIFICATION_EXACT_SCHEMA_INVALID");
  if (!exactKeys(value, top)) return { blockers, descriptors: [] };
  add(blockers, value.schema === "blocked-branch-reopen/renzo-dual-group-qualification/v2", "RENZO_QUALIFICATION_SCHEMA_INVALID");
  add(blockers, validId(value.lineageId), "RENZO_QUALIFICATION_LINEAGE_ID_INVALID");
  add(blockers, freshTime(value.observedAt, nowMs), "RENZO_QUALIFICATION_OBSERVATION_NOT_FRESH");
  add(blockers, value.success === true, "RENZO_QUALIFICATION_NOT_SUCCESSFUL");
  add(blockers, value.sanitized === true, "RENZO_QUALIFICATION_NOT_SANITIZED");
  add(blockers, value.providerMaterialAbsent === true, "RENZO_QUALIFICATION_PROVIDER_MATERIAL_PRESENT");
  add(blockers, value.groupCount === 2, "RENZO_QUALIFICATION_GROUP_COUNT_INVALID");
  add(blockers, value.distinctGroups === true, "RENZO_QUALIFICATION_GROUPS_NOT_DISTINCT");
  add(blockers, value.identicalFinalizedHeader === true, "RENZO_FINALIZED_HEADERS_NOT_IDENTICAL");
  add(blockers, exactKeys(value.finalizedHeader, ["number", "hash"]), "RENZO_FINALIZED_HEADER_EXACT_SCHEMA_INVALID");
  add(blockers, Number.isSafeInteger(value.finalizedHeader?.number) && value.finalizedHeader.number >= 0, "RENZO_FINALIZED_NUMBER_INVALID");
  add(blockers, Boolean(normalizeHash(value.finalizedHeader?.hash)), "RENZO_FINALIZED_HASH_INVALID");
  add(blockers, Boolean(normalizeHash(value.sourceLineageDigest)), "RENZO_SOURCE_LINEAGE_DIGEST_INVALID");
  add(blockers, descriptorShape(value.output), "RENZO_OUTPUT_DESCRIPTOR_INVALID");
  add(blockers, descriptorShape(value.approval), "RENZO_APPROVAL_DESCRIPTOR_INVALID");
  add(blockers, Boolean(normalizeHash(value.outputSha256)), "RENZO_OUTPUT_HASH_INVALID");
  add(blockers, Boolean(normalizeHash(value.approvalSha256)), "RENZO_APPROVAL_HASH_INVALID");
  add(blockers, normalizeHash(value.outputSha256) === normalizeHash(value.output?.sha256), "RENZO_OUTPUT_HASH_BINDING_INVALID");
  add(blockers, normalizeHash(value.approvalSha256) === normalizeHash(value.approval?.sha256), "RENZO_APPROVAL_HASH_BINDING_INVALID");
  add(blockers, value.retry === false, "RENZO_RETRY_MUST_BE_FALSE");
  const descriptors = [{ name: "OUTPUT", value: value.output }, { name: "APPROVAL", value: value.approval }];
  return { blockers: sortedUnique(blockers), descriptors: descriptors.every((row) => descriptorShape(row.value)) ? descriptors : [] };
}
function validateFraxlend(value, nowMs) {
  const blockers = [];
  const top = ["schema", "validated", "explicit", "observedAt", "compiler", "standardInput", "standardOutput", "metadata", "immutableReferences", "pairRuntimeTemplates", "oracleRuntimeTemplates", "staticOracleBinding", "authorities"];
  add(blockers, exactKeys(value, top), "FRAXLEND_EXACT_SCHEMA_INVALID");
  if (!exactKeys(value, top)) return { blockers, descriptors: [] };
  add(blockers, value.schema === "blocked-branch-reopen/fraxlend-explicit-manifest/v2", "FRAXLEND_SCHEMA_INVALID");
  add(blockers, value.validated === true, "FRAXLEND_MANIFEST_NOT_VALIDATED");
  add(blockers, value.explicit === true, "FRAXLEND_MANIFEST_NOT_EXPLICIT");
  add(blockers, freshTime(value.observedAt, nowMs), "FRAXLEND_OBSERVATION_NOT_FRESH");
  add(blockers, compilerShape(value.compiler), "FRAXLEND_COMPILER_REFERENCE_INVALID");
  const singles = [["STANDARD_INPUT", value.standardInput], ["STANDARD_OUTPUT", value.standardOutput], ["METADATA", value.metadata], ["IMMUTABLE_REFERENCES", value.immutableReferences]];
  for (const row of singles) add(blockers, descriptorShape(row[1]), `FRAXLEND_${row[0]}_INVALID`);
  add(blockers, Array.isArray(value.pairRuntimeTemplates) && value.pairRuntimeTemplates.length > 0
    && value.pairRuntimeTemplates.length <= MAX_DESCRIPTOR_ARRAY_COUNT && value.pairRuntimeTemplates.every(descriptorShape), "FRAXLEND_PAIR_RUNTIME_TEMPLATES_INVALID");
  add(blockers, Array.isArray(value.oracleRuntimeTemplates) && value.oracleRuntimeTemplates.length > 0
    && value.oracleRuntimeTemplates.length <= MAX_DESCRIPTOR_ARRAY_COUNT && value.oracleRuntimeTemplates.every(descriptorShape), "FRAXLEND_ORACLE_RUNTIME_TEMPLATES_INVALID");
  add(blockers, exactKeys(value.staticOracleBinding, ["validated", "evidence"]) && value.staticOracleBinding.validated === true && descriptorShape(value.staticOracleBinding.evidence), "FRAXLEND_STATIC_ORACLE_BINDING_INVALID");
  add(blockers, exactKeys(value.authorities, ["fair", "acquisition", "exit"]), "FRAXLEND_AUTHORITIES_EXACT_SCHEMA_INVALID");
  if (exactKeys(value.authorities, ["fair", "acquisition", "exit"])) {
    for (const name of ["fair", "acquisition", "exit"]) add(blockers, exactKeys(value.authorities[name], ["fixed", "evidence"]) && value.authorities[name].fixed === true && descriptorShape(value.authorities[name].evidence), `FRAXLEND_${name.toUpperCase()}_AUTHORITY_INVALID`);
  }
  const descriptors = [];
  if (compilerShape(value.compiler)) descriptors.push({ name: "COMPILER", value: value.compiler });
  for (const row of singles) if (descriptorShape(row[1])) descriptors.push({ name: row[0], value: row[1] });
  if (Array.isArray(value.pairRuntimeTemplates)) value.pairRuntimeTemplates.slice(0, MAX_DESCRIPTOR_ARRAY_COUNT).forEach((item, index) => { if (descriptorShape(item)) descriptors.push({ name: `PAIR_RUNTIME_${index}`, value: item }); });
  if (Array.isArray(value.oracleRuntimeTemplates)) value.oracleRuntimeTemplates.slice(0, MAX_DESCRIPTOR_ARRAY_COUNT).forEach((item, index) => { if (descriptorShape(item)) descriptors.push({ name: `ORACLE_RUNTIME_${index}`, value: item }); });
  if (descriptorShape(value.staticOracleBinding?.evidence)) descriptors.push({ name: "STATIC_ORACLE_BINDING", value: value.staticOracleBinding.evidence });
  for (const name of ["fair", "acquisition", "exit"]) if (descriptorShape(value.authorities?.[name]?.evidence)) descriptors.push({ name: `${name.toUpperCase()}_AUTHORITY`, value: value.authorities[name].evidence });
  return { blockers: sortedUnique(blockers), descriptors };
}
function validateLocalStorageAttestation(value, nowMs) {
  const blockers = [];
  const keys = ["schema", "evidenceRoot", "fullyLocalNonTiered", "genericReparsePointsAbsent", "reviewed", "reviewerId", "observedAt", "expiresAt"];
  add(blockers, exactKeys(value, keys), "LOCAL_STORAGE_ATTESTATION_EXACT_SCHEMA_INVALID");
  if (!exactKeys(value, keys)) return blockers;
  add(blockers, value.schema === "blocked-branch-reopen/local-storage-attestation/v1", "LOCAL_STORAGE_ATTESTATION_SCHEMA_INVALID");
  add(blockers, value.evidenceRoot === EVIDENCE_ROOT, "LOCAL_STORAGE_ATTESTATION_EVIDENCE_ROOT_INVALID");
  add(blockers, value.fullyLocalNonTiered === true, "LOCAL_STORAGE_ATTESTATION_NOT_FULLY_LOCAL");
  add(blockers, value.genericReparsePointsAbsent === true, "LOCAL_STORAGE_ATTESTATION_REPARSE_ABSENCE_UNAPPROVED");
  add(blockers, value.reviewed === true && validId(value.reviewerId), "LOCAL_STORAGE_ATTESTATION_REVIEW_INVALID");
  add(blockers, freshTime(value.observedAt, nowMs), "LOCAL_STORAGE_ATTESTATION_OBSERVATION_NOT_FRESH");
  add(blockers, validTime(value.expiresAt) && Date.parse(value.expiresAt) > nowMs
    && Date.parse(value.expiresAt) - Date.parse(value.observedAt) > 0
    && Date.parse(value.expiresAt) - Date.parse(value.observedAt) <= MAX_EVIDENCE_AGE_MS,
  "LOCAL_STORAGE_ATTESTATION_EXPIRY_INVALID");
  return sortedUnique(blockers);
}
function validateUniswapxLineage(value, nowMs) {
  const blockers = [];
  const top = ["schema", "lineageId", "newLineage", "reviewed", "reviewedAt", "observedAt", "retry", "consumedLineage", "currentApprovalLedgerExcluded", "artifacts"];
  add(blockers, exactKeys(value, top), "UNISWAPX_LINEAGE_EXACT_SCHEMA_INVALID");
  if (!exactKeys(value, top)) return { blockers, descriptors: [] };
  add(blockers, value.schema === "blocked-branch-reopen/uniswapx-lineage/v2", "UNISWAPX_LINEAGE_SCHEMA_INVALID");
  add(blockers, validId(value.lineageId), "UNISWAPX_LINEAGE_ID_INVALID");
  add(blockers, value.newLineage === true, "UNISWAPX_LINEAGE_NOT_NEW");
  add(blockers, value.reviewed === true, "UNISWAPX_LINEAGE_NOT_REVIEWED");
  add(blockers, freshTime(value.reviewedAt, nowMs), "UNISWAPX_REVIEW_TIME_NOT_FRESH");
  add(blockers, freshTime(value.observedAt, nowMs), "UNISWAPX_OBSERVATION_NOT_FRESH");
  add(blockers, value.retry === false, "UNISWAPX_RETRY_MUST_BE_FALSE");
  add(blockers, value.consumedLineage === false, "UNISWAPX_CONSUMED_LINEAGE_REJECTED");
  add(blockers, value.currentApprovalLedgerExcluded === true, "UNISWAPX_CURRENT_APPROVAL_LEDGER_EXCLUSION_MISSING");
  add(blockers, exactKeys(value.artifacts, ["runner", "approval", "ledger", "output"]), "UNISWAPX_ARTIFACTS_EXACT_SCHEMA_INVALID");
  if (!exactKeys(value.artifacts, ["runner", "approval", "ledger", "output"])) return { blockers, descriptors: [] };
  const descriptors = Object.entries(value.artifacts).map(([name, item]) => ({ name: name.toUpperCase(), value: item }));
  for (const row of descriptors) add(blockers, descriptorShape(row.value), `UNISWAPX_${row.name}_DESCRIPTOR_INVALID`);
  return { blockers: sortedUnique(blockers), descriptors: descriptors.every((row) => descriptorShape(row.value)) ? descriptors : [] };
}
function validateUniswapxDurability(value, nowMs) {
  const blockers = [];
  const top = ["schema", "lineageId", "observedAt", "validated", "sanitized", "preInventory", "sourceLineageDigest", "parentDirectory"];
  add(blockers, exactKeys(value, top), "UNISWAPX_DURABILITY_EXACT_SCHEMA_INVALID");
  if (!exactKeys(value, top)) return { blockers, descriptors: [] };
  add(blockers, value.schema === "blocked-branch-reopen/uniswapx-parent-durability/v2", "UNISWAPX_DURABILITY_SCHEMA_INVALID");
  add(blockers, validId(value.lineageId), "UNISWAPX_DURABILITY_LINEAGE_ID_INVALID");
  add(blockers, freshTime(value.observedAt, nowMs), "UNISWAPX_DURABILITY_OBSERVATION_NOT_FRESH");
  add(blockers, value.validated === true, "UNISWAPX_DURABILITY_NOT_VALIDATED");
  add(blockers, value.sanitized === true, "UNISWAPX_DURABILITY_NOT_SANITIZED");
  add(blockers, value.preInventory === true, "UNISWAPX_DURABILITY_NOT_PRE_INVENTORY");
  add(blockers, Boolean(normalizeHash(value.sourceLineageDigest)), "UNISWAPX_SOURCE_LINEAGE_DIGEST_INVALID");
  add(blockers, exactKeys(value.parentDirectory, ["durable", "fsyncVerified", "evidence"]) && value.parentDirectory.durable === true && value.parentDirectory.fsyncVerified === true && descriptorShape(value.parentDirectory.evidence), "UNISWAPX_PARENT_DURABILITY_EVIDENCE_INVALID");
  return { blockers: sortedUnique(blockers), descriptors: descriptorShape(value.parentDirectory?.evidence) ? [{ name: "PARENT_DURABILITY", value: value.parentDirectory.evidence }] : [] };
}
function validateValantisLineage(value, nowMs) {
  const blockers = [];
  const top = ["schema", "lineageId", "newLineage", "reviewed", "reviewedAt", "observedAt", "artifacts", "predecessorBindings", "retry", "importsConsumedLineage", "reusesConsumedLineage"];
  add(blockers, exactKeys(value, top), "VALANTIS_LINEAGE_EXACT_SCHEMA_INVALID");
  if (!exactKeys(value, top)) return { blockers, descriptors: [] };
  add(blockers, value.schema === "blocked-branch-reopen/valantis-successor-lineage/v1", "VALANTIS_LINEAGE_SCHEMA_INVALID");
  add(blockers, validId(value.lineageId), "VALANTIS_LINEAGE_ID_INVALID");
  add(blockers, value.newLineage === true && value.reviewed === true, "VALANTIS_LINEAGE_NOT_NEW_REVIEWED");
  add(blockers, freshTime(value.reviewedAt, nowMs), "VALANTIS_REVIEW_TIME_NOT_FRESH");
  add(blockers, freshTime(value.observedAt, nowMs), "VALANTIS_OBSERVATION_NOT_FRESH");
  add(blockers, value.retry === false, "VALANTIS_RETRY_MUST_BE_FALSE");
  add(blockers, value.importsConsumedLineage === false, "VALANTIS_CONSUMED_IMPORT_REJECTED");
  add(blockers, value.reusesConsumedLineage === false, "VALANTIS_CONSUMED_REUSE_REJECTED");
  add(blockers, exactKeys(value.artifacts, ["runner", "test", "authority", "package", "output"]), "VALANTIS_ARTIFACTS_EXACT_SCHEMA_INVALID");
  add(blockers, exactKeys(value.predecessorBindings, ["step2sDiagnosticSha256", "step2sRunnerSha256", "step2sAuthoritySha256", "step2sPackageSha256"]), "VALANTIS_PREDECESSOR_BINDINGS_EXACT_SCHEMA_INVALID");
  if (exactKeys(value.predecessorBindings, ["step2sDiagnosticSha256", "step2sRunnerSha256", "step2sAuthoritySha256", "step2sPackageSha256"])) {
    add(blockers, value.predecessorBindings.step2sDiagnosticSha256 === VALANTIS_PREDECESSOR.diagnostic, "VALANTIS_STEP2S_DIAGNOSTIC_BINDING_INVALID");
    add(blockers, value.predecessorBindings.step2sRunnerSha256 === VALANTIS_PREDECESSOR.runner, "VALANTIS_STEP2S_RUNNER_BINDING_INVALID");
    add(blockers, value.predecessorBindings.step2sAuthoritySha256 === VALANTIS_PREDECESSOR.authority, "VALANTIS_STEP2S_AUTHORITY_BINDING_INVALID");
    add(blockers, value.predecessorBindings.step2sPackageSha256 === VALANTIS_PREDECESSOR.package, "VALANTIS_STEP2S_PACKAGE_BINDING_INVALID");
  }
  if (!exactKeys(value.artifacts, ["runner", "test", "authority", "package", "output"])) return { blockers: sortedUnique(blockers), descriptors: [] };
  const descriptors = Object.entries(value.artifacts).map(([name, item]) => ({ name: name.toUpperCase(), value: item }));
  for (const row of descriptors) add(blockers, descriptorShape(row.value), `VALANTIS_${row.name}_DESCRIPTOR_INVALID`);
  return { blockers: sortedUnique(blockers), descriptors: descriptors.every((row) => descriptorShape(row.value)) ? descriptors : [] };
}
function validateValantisCapability(value, nowMs) {
  const blockers = [];
  const top = ["schema", "lineageId", "reviewed", "reviewerId", "sanitized", "observedAt", "expiresAt", "sourceLineageDigest", "chainId", "groupsOpaque", "opaqueGroupCount", "distinctGroups", "identicalFinalizedHeader", "identicalFinalizedBlock", "terminalRecheck", "materialNewEvidence", "providerMaterialAbsent", "networkCaptureAuthorized"];
  add(blockers, exactKeys(value, top), "VALANTIS_CAPABILITY_EXACT_SCHEMA_INVALID");
  if (!exactKeys(value, top)) return blockers;
  add(blockers, value.schema === "blocked-branch-reopen/valantis-finality-capability/v1", "VALANTIS_CAPABILITY_SCHEMA_INVALID");
  add(blockers, validId(value.lineageId), "VALANTIS_CAPABILITY_LINEAGE_ID_INVALID");
  add(blockers, value.reviewed === true && validId(value.reviewerId), "VALANTIS_CAPABILITY_REVIEW_INVALID");
  add(blockers, value.sanitized === true, "VALANTIS_CAPABILITY_NOT_SANITIZED");
  add(blockers, freshTime(value.observedAt, nowMs), "VALANTIS_CAPABILITY_OBSERVATION_NOT_FRESH");
  add(blockers, validTime(value.expiresAt) && Date.parse(value.expiresAt) > nowMs
    && Date.parse(value.expiresAt) - Date.parse(value.observedAt) > 0
    && Date.parse(value.expiresAt) - Date.parse(value.observedAt) <= MAX_EVIDENCE_AGE_MS, "VALANTIS_CAPABILITY_EXPIRY_INVALID");
  add(blockers, Boolean(normalizeHash(value.sourceLineageDigest)), "VALANTIS_CAPABILITY_LINEAGE_DIGEST_INVALID");
  add(blockers, value.chainId === 999, "VALANTIS_CHAIN_ID_INVALID");
  add(blockers, value.groupsOpaque === true && value.opaqueGroupCount === 2, "VALANTIS_OPAQUE_GROUPS_INVALID");
  add(blockers, value.distinctGroups === true, "VALANTIS_GROUPS_NOT_DISTINCT");
  add(blockers, value.identicalFinalizedHeader === true, "VALANTIS_FINALIZED_HEADERS_NOT_IDENTICAL");
  add(blockers, exactKeys(value.identicalFinalizedBlock, ["number", "hash", "stateRoot"]), "VALANTIS_FINALIZED_HEADER_EXACT_SCHEMA_INVALID");
  add(blockers, Number.isSafeInteger(value.identicalFinalizedBlock?.number) && value.identicalFinalizedBlock.number >= 0, "VALANTIS_FINALIZED_NUMBER_INVALID");
  add(blockers, Boolean(normalizeHash(value.identicalFinalizedBlock?.hash)), "VALANTIS_FINALIZED_HASH_INVALID");
  add(blockers, Boolean(normalizeHash(value.identicalFinalizedBlock?.stateRoot)), "VALANTIS_FINALIZED_STATE_ROOT_INVALID");
  add(blockers, value.terminalRecheck === true, "VALANTIS_TERMINAL_RECHECK_REQUIRED");
  add(blockers, value.materialNewEvidence === true, "VALANTIS_MATERIAL_NEW_EVIDENCE_REQUIRED");
  add(blockers, value.providerMaterialAbsent === true, "VALANTIS_PROVIDER_MATERIAL_PRESENT");
  add(blockers, value.networkCaptureAuthorized === false, "VALANTIS_NETWORK_AUTHORIZATION_REJECTED");
  return sortedUnique(blockers);
}

function inputBlocker(prefix, error) { return `${prefix}_${error instanceof MonitorError ? error.code : "INPUT_READ_FAILED"}`; }
async function loadOptional(root, relative, prefix, budget) {
  if (!relative) return { blocker: `${prefix}_ABSENT` };
  try { return { record: await readSafeJson(root, evidenceRelative(relative), MAX_INPUT_BYTES, true, budget) }; }
  catch (error) { return { blocker: inputBlocker(prefix, error) }; }
}
function historicalFromPrior(priorRow, nowMs) {
  if (!priorRow) return null;
  let candidate = priorRow.priorValidatedObservation;
  if (priorRow.status === "REOPEN_CANDIDATE") {
    candidate = {
      advisory: HISTORICAL_ADVISORY,
      expiresAt: isoNow(Date.parse(priorRow.observedAt) + HISTORY_TTL_MS),
      lineageDigests: [...priorRow.lineageDigests],
      observedAt: priorRow.observedAt,
    };
  }
  if (!candidate || !validTime(candidate.observedAt) || !validTime(candidate.expiresAt)) return null;
  const observed = Date.parse(candidate.observedAt);
  const expires = Date.parse(candidate.expiresAt);
  if (observed > nowMs || expires <= nowMs || expires - observed !== HISTORY_TTL_MS || candidate.advisory !== HISTORICAL_ADVISORY) return null;
  return JSON.parse(JSON.stringify(candidate));
}
function branch(status, blockers, records, lineageDigests, observedAt, priorValidatedObservation) {
  const evidence = new Map();
  for (const record of records.filter(Boolean)) evidence.set(record.path, evidenceView(record));
  return {
    advisory: ADVISORY,
    blockers: sortedUnique(blockers),
    evidence: [...evidence.values()].sort((a, b) => a.path.localeCompare(b.path)),
    lineageDigests: sortedUnique(lineageDigests.filter(Boolean)),
    observedAt,
    priorValidatedObservation,
    status,
    validUntil: null,
  };
}
function conservativeValidUntil(values) {
  const times = values.filter(validTime).map((value) => Date.parse(value));
  if (!times.length || times.some((value) => !Number.isFinite(value))) return null;
  return isoNow(Math.min(...times));
}
function freshnessExpiry(value) { return validTime(value) ? isoNow(Date.parse(value) + MAX_EVIDENCE_AGE_MS) : null; }
function requireCurrentValidity(blockers, validUntil, nowMs, prefix) {
  if (!validTime(validUntil) || Date.parse(validUntil) <= nowMs) blockers.push(`${prefix}_VALIDITY_WINDOW_EXPIRED`);
}
async function readPriorState(root, out, nowMs, budget) {
  try {
    const value = (await readSafeJson(root, out, MAX_STATE_BYTES, false, budget)).value;
    validateState(value, nowMs);
    return value;
  } catch { return null; }
}
async function evaluate(options = {}, dependencies = {}) {
  const root = path.resolve(dependencies.root || ROOT);
  const out = outputRelative(dependencies.outputRelative || DEFAULT_OUTPUT);
  const nowValue = typeof dependencies.now === "function" ? dependencies.now() : dependencies.now;
  const nowMs = nowValue === undefined ? Date.now() : new Date(nowValue).getTime();
  if (!Number.isFinite(nowMs)) fail("TIME_INVALID");
  const budget = dependencies.readBudget || new ReadBudget(dependencies.readBudgetLimit || MAX_CYCLE_READ_BYTES);
  const observedAt = isoNow(nowMs);
  const prior = await readPriorState(root, out, nowMs, budget);
  const loaded = {
    storage: await loadOptional(root, options.localStorageAttestation, "LOCAL_STORAGE_ATTESTATION", budget),
    rl: await loadOptional(root, options.renzoLineage, "RENZO_LINEAGE_MANIFEST", budget),
    rq: await loadOptional(root, options.renzoQualification, "RENZO_QUALIFICATION_ARTIFACT", budget),
    f: await loadOptional(root, options.fraxlendManifest, "FRAXLEND_MANIFEST", budget),
    ul: await loadOptional(root, options.uniswapxLineage, "UNISWAPX_LINEAGE_MANIFEST", budget),
    ud: await loadOptional(root, options.uniswapxDurability, "UNISWAPX_DURABILITY_ARTIFACT", budget),
    vl: await loadOptional(root, options.valantisLineage, "VALANTIS_SUCCESSOR_LINEAGE", budget),
    vc: await loadOptional(root, options.valantisCapability, "VALANTIS_FINALITY_CAPABILITY", budget),
  };

  const sharedBlockers = [loaded.storage.blocker].filter(Boolean);
  if (loaded.storage.record) sharedBlockers.push(...validateLocalStorageAttestation(loaded.storage.record.value, nowMs));
  let descriptorCycleCount = 0;
  let descriptorCycleExceeded = false;
  const admitDescriptorCount = (count) => {
    if (descriptorCycleCount + count > MAX_DESCRIPTORS_PER_CYCLE) { descriptorCycleExceeded = true; return false; }
    descriptorCycleCount += count;
    return true;
  };

  const rb = [loaded.rl.blocker, loaded.rq.blocker].filter(Boolean);
  const rRecords = [loaded.rl.record, loaded.rq.record].filter(Boolean);
  let rLine = { blockers: [], descriptors: [] };
  let rQual = { blockers: [], descriptors: [] };
  if (loaded.rl.record) { rLine = validateRenzoLineage(loaded.rl.record.value, nowMs); rb.push(...rLine.blockers); }
  if (loaded.rq.record) { rQual = validateRenzoQualification(loaded.rq.record.value, nowMs); rb.push(...rQual.blockers); }
  const rDescriptors = [...rLine.descriptors, ...rQual.descriptors];
  if (rDescriptors.length > MAX_DESCRIPTORS_PER_BRANCH) rb.push("RENZO_DESCRIPTOR_COUNT_EXCEEDED");
  const rDescriptorBudgetOk = rDescriptors.length <= MAX_DESCRIPTORS_PER_BRANCH && admitDescriptorCount(rDescriptors.length);
  if (rDescriptors.length && rDescriptorBudgetOk) {
    const verified = await verifyDescriptors(root, rDescriptors.slice(0, MAX_DESCRIPTORS_PER_BRANCH), "RENZO", budget);
    rb.push(...verified.blockers); rRecords.push(...verified.records);
  }
  if (loaded.rl.record && loaded.rq.record) {
    add(rb, loaded.rq.record.value.sourceLineageDigest === loaded.rl.record.sha256, "RENZO_QUALIFICATION_LINEAGE_BINDING_MISMATCH");
    add(rb, loaded.rq.record.value.lineageId === loaded.rl.record.value.lineageId, "RENZO_QUALIFICATION_LINEAGE_ID_MISMATCH");
    add(rb, loaded.rq.record.value.approvalSha256 === loaded.rl.record.value.artifacts?.approval?.sha256, "RENZO_APPROVAL_LINEAGE_BINDING_MISMATCH");
    add(rb, loaded.rq.record.value.approval?.path === loaded.rl.record.value.artifacts?.approval?.path, "RENZO_APPROVAL_PATH_BINDING_MISMATCH");
    add(rb, loaded.rl.record.path !== loaded.rq.record.path, "RENZO_LINEAGE_AND_QUALIFICATION_NOT_SEPARATE");
  }
  if (rDescriptors.length) {
    const distinctRenzo = [...rLine.descriptors, ...rQual.descriptors.filter((row) => row.name === "OUTPUT")];
    add(rb, uniquePaths(distinctRenzo, rRecords.slice(0, 2).map((x) => x.path)), "RENZO_EVIDENCE_PATHS_NOT_DISTINCT");
    const hashes = [loaded.rl.record?.sha256, loaded.rq.record?.sha256, ...rDescriptors.map((x) => normalizeHash(x.value.sha256))].filter(Boolean);
    const lineageHashes = [loaded.rl.record?.sha256, loaded.rq.record?.sha256, ...rLine.descriptors.map((x) => normalizeHash(x.value.sha256)), normalizeHash(loaded.rq.record?.value.outputSha256)].filter(Boolean);
    add(rb, new Set(lineageHashes).size === lineageHashes.length, "RENZO_LINEAGE_HASHES_NOT_DISTINCT");
    add(rb, !hashes.some((hash) => CONSUMED_RENZO_HASHES.has(hash)), "RENZO_CONSUMED_STEP5_HASH_REJECTED");
  }

  const fb = [loaded.f.blocker].filter(Boolean);
  const fRecords = [loaded.f.record].filter(Boolean);
  let fManifest = { blockers: [], descriptors: [] };
  if (loaded.f.record) { fManifest = validateFraxlend(loaded.f.record.value, nowMs); fb.push(...fManifest.blockers); }
  if (fManifest.descriptors.length > MAX_DESCRIPTORS_PER_BRANCH) fb.push("FRAXLEND_DESCRIPTOR_COUNT_EXCEEDED");
  const fDescriptorBudgetOk = fManifest.descriptors.length <= MAX_DESCRIPTORS_PER_BRANCH && admitDescriptorCount(fManifest.descriptors.length);
  if (fManifest.descriptors.length && fDescriptorBudgetOk) {
    add(fb, uniquePaths(fManifest.descriptors, [loaded.f.record.path]), "FRAXLEND_EVIDENCE_PATHS_NOT_DISTINCT");
    const verified = await verifyDescriptors(root, fManifest.descriptors.slice(0, MAX_DESCRIPTORS_PER_BRANCH), "FRAXLEND", budget);
    fb.push(...verified.blockers); fRecords.push(...verified.records);
  }

  const ub = [loaded.ul.blocker, loaded.ud.blocker].filter(Boolean);
  const uRecords = [loaded.ul.record, loaded.ud.record].filter(Boolean);
  let uLine = { blockers: [], descriptors: [] };
  let uDur = { blockers: [], descriptors: [] };
  if (loaded.ul.record) { uLine = validateUniswapxLineage(loaded.ul.record.value, nowMs); ub.push(...uLine.blockers); }
  if (loaded.ud.record) { uDur = validateUniswapxDurability(loaded.ud.record.value, nowMs); ub.push(...uDur.blockers); }
  const uDescriptors = [...uLine.descriptors, ...uDur.descriptors];
  if (uDescriptors.length > MAX_DESCRIPTORS_PER_BRANCH) ub.push("UNISWAPX_DESCRIPTOR_COUNT_EXCEEDED");
  const uDescriptorBudgetOk = uDescriptors.length <= MAX_DESCRIPTORS_PER_BRANCH && admitDescriptorCount(uDescriptors.length);
  if (uDescriptors.length && uDescriptorBudgetOk) {
    add(ub, uniquePaths(uDescriptors, uRecords.slice(0, 2).map((x) => x.path)), "UNISWAPX_EVIDENCE_PATHS_NOT_DISTINCT");
    const verified = await verifyDescriptors(root, uDescriptors.slice(0, MAX_DESCRIPTORS_PER_BRANCH), "UNISWAPX", budget);
    ub.push(...verified.blockers); uRecords.push(...verified.records);
  }
  if (loaded.ul.record && loaded.ud.record) {
    add(ub, loaded.ud.record.value.sourceLineageDigest === loaded.ul.record.sha256, "UNISWAPX_DURABILITY_LINEAGE_BINDING_MISMATCH");
    add(ub, loaded.ud.record.value.lineageId === loaded.ul.record.value.lineageId, "UNISWAPX_DURABILITY_LINEAGE_ID_MISMATCH");
    add(ub, loaded.ul.record.path !== loaded.ud.record.path, "UNISWAPX_LINEAGE_AND_DURABILITY_NOT_SEPARATE");
  }
  if (uLine.descriptors.length) {
    const hashes = [loaded.ul.record?.sha256, ...uLine.descriptors.map((x) => normalizeHash(x.value.sha256))].filter(Boolean);
    add(ub, new Set(hashes).size === hashes.length, "UNISWAPX_LINEAGE_HASHES_NOT_DISTINCT");
    add(ub, !hashes.some((hash) => CONSUMED_UNISWAPX_HASHES.has(hash)), "UNISWAPX_CURRENT_APPROVAL_LEDGER_OR_CONSUMED_HASH_REJECTED");
  }

  const vb = [loaded.vl.blocker, loaded.vc.blocker].filter(Boolean);
  const vRecords = [loaded.vl.record, loaded.vc.record].filter(Boolean);
  let vLine = { blockers: [], descriptors: [] };
  if (loaded.vl.record) { vLine = validateValantisLineage(loaded.vl.record.value, nowMs); vb.push(...vLine.blockers); }
  if (loaded.vc.record) vb.push(...validateValantisCapability(loaded.vc.record.value, nowMs));
  if (loaded.vl.record && path.posix.basename(loaded.vl.record.path) !== "valantis-successor-lineage.json") vb.push("VALANTIS_LINEAGE_FILENAME_INVALID");
  if (loaded.vc.record && path.posix.basename(loaded.vc.record.path) !== "valantis-finality-capability.json") vb.push("VALANTIS_CAPABILITY_FILENAME_INVALID");
  if (vLine.descriptors.length > MAX_DESCRIPTORS_PER_BRANCH) vb.push("VALANTIS_DESCRIPTOR_COUNT_EXCEEDED");
  const vDescriptorBudgetOk = vLine.descriptors.length <= MAX_DESCRIPTORS_PER_BRANCH && admitDescriptorCount(vLine.descriptors.length);
  const vVerifiedHashes = [];
  if (vLine.descriptors.length && vDescriptorBudgetOk) {
    add(vb, uniquePaths(vLine.descriptors, vRecords.slice(0, 2).map((x) => x.path)), "VALANTIS_EVIDENCE_PATHS_NOT_DISTINCT");
    const verified = await verifyDescriptors(root, vLine.descriptors, "VALANTIS", budget);
    vb.push(...verified.blockers); vRecords.push(...verified.records); vVerifiedHashes.push(...verified.records.map((record) => record.sha256));
  }
  if (loaded.vl.record && loaded.vc.record) {
    add(vb, loaded.vc.record.value.sourceLineageDigest === loaded.vl.record.sha256, "VALANTIS_CAPABILITY_LINEAGE_BINDING_MISMATCH");
    add(vb, loaded.vc.record.value.lineageId === loaded.vl.record.value.lineageId, "VALANTIS_CAPABILITY_LINEAGE_ID_MISMATCH");
    add(vb, loaded.vl.record.path !== loaded.vc.record.path, "VALANTIS_LINEAGE_AND_CAPABILITY_NOT_SEPARATE");
    add(vb, loaded.vl.record.sha256 !== loaded.vc.record.sha256, "VALANTIS_LINEAGE_CAPABILITY_HASH_NOT_DISTINCT");
  }
  if (vLine.descriptors.length) {
    const actualHashes = [loaded.vl.record?.sha256, loaded.vc.record?.sha256, ...vVerifiedHashes].filter(Boolean);
    const declaredHashes = vLine.descriptors.map((row) => normalizeHash(row.value.sha256)).filter(Boolean);
    add(vb, new Set(actualHashes).size === actualHashes.length, "VALANTIS_LINEAGE_HASHES_NOT_DISTINCT");
    add(vb, ![...actualHashes, ...declaredHashes].some((hash) => CONSUMED_VALANTIS_HASHES.has(hash)), "VALANTIS_CONSUMED_LINEAGE_HASH_REJECTED");
  }

  if (descriptorCycleExceeded) {
    rb.push("RENZO_DESCRIPTOR_CYCLE_BUDGET_EXCEEDED");
    fb.push("FRAXLEND_DESCRIPTOR_CYCLE_BUDGET_EXCEEDED");
    ub.push("UNISWAPX_DESCRIPTOR_CYCLE_BUDGET_EXCEEDED");
    vb.push("VALANTIS_DESCRIPTOR_CYCLE_BUDGET_EXCEEDED");
  }

  const branchPathSets = {
    renzo: new Set(rRecords.map((record) => record.path)),
    fraxlend: new Set(fRecords.map((record) => record.path)),
    uniswapx: new Set(uRecords.map((record) => record.path)),
    valantis: new Set(vRecords.map((record) => record.path)),
  };
  const blockerTargets = { renzo: rb, fraxlend: fb, uniswapx: ub, valantis: vb };
  for (let left = 0; left < BRANCHES.length; left += 1) {
    for (let right = left + 1; right < BRANCHES.length; right += 1) {
      const a = BRANCHES[left]; const b = BRANCHES[right];
      if ([...branchPathSets[a]].some((item) => branchPathSets[b].has(item))) {
        blockerTargets[a].push(`${a.toUpperCase()}_CROSS_BRANCH_EVIDENCE_REUSE_REJECTED`);
        blockerTargets[b].push(`${b.toUpperCase()}_CROSS_BRANCH_EVIDENCE_REUSE_REJECTED`);
      }
    }
  }
  if (loaded.storage.record && [rRecords, fRecords, uRecords, vRecords].some((records) => records.some((record) => record.path === loaded.storage.record.path))) {
    sharedBlockers.push("LOCAL_STORAGE_ATTESTATION_NOT_SEPARATE");
  }
  rb.push(...sharedBlockers); fb.push(...sharedBlockers); ub.push(...sharedBlockers); vb.push(...sharedBlockers);
  if (loaded.storage.record) { rRecords.push(loaded.storage.record); fRecords.push(loaded.storage.record); uRecords.push(loaded.storage.record); vRecords.push(loaded.storage.record); }

  const storageValue = loaded.storage.record?.value;
  const sharedValidity = [storageValue?.expiresAt, freshnessExpiry(storageValue?.observedAt)];
  const rValidUntil = conservativeValidUntil([
    ...sharedValidity,
    freshnessExpiry(loaded.rl.record?.value.observedAt),
    freshnessExpiry(loaded.rl.record?.value.reviewedAt),
    freshnessExpiry(loaded.rq.record?.value.observedAt),
  ]);
  const fValidUntil = conservativeValidUntil([
    ...sharedValidity,
    freshnessExpiry(loaded.f.record?.value.observedAt),
  ]);
  const uValidUntil = conservativeValidUntil([
    ...sharedValidity,
    freshnessExpiry(loaded.ul.record?.value.observedAt),
    freshnessExpiry(loaded.ul.record?.value.reviewedAt),
    freshnessExpiry(loaded.ud.record?.value.observedAt),
  ]);
  const vValidUntil = conservativeValidUntil([
    ...sharedValidity,
    freshnessExpiry(loaded.vl.record?.value.observedAt),
    freshnessExpiry(loaded.vl.record?.value.reviewedAt),
    freshnessExpiry(loaded.vc.record?.value.observedAt),
    loaded.vc.record?.value.expiresAt,
  ]);
  if (!rb.length) requireCurrentValidity(rb, rValidUntil, nowMs, "RENZO");
  if (!fb.length) requireCurrentValidity(fb, fValidUntil, nowMs, "FRAXLEND");
  if (!ub.length) requireCurrentValidity(ub, uValidUntil, nowMs, "UNISWAPX");
  if (!vb.length) requireCurrentValidity(vb, vValidUntil, nowMs, "VALANTIS");

  const branches = {
    renzo: branch(rb.length ? "HOLD" : "REOPEN_CANDIDATE", rb, rRecords, rb.length ? [] : [loaded.rl.record?.sha256], observedAt, historicalFromPrior(prior?.branches?.renzo, nowMs)),
    fraxlend: branch(fb.length ? "HOLD" : "REOPEN_CANDIDATE", fb, fRecords, fb.length ? [] : [loaded.f.record?.sha256], observedAt, historicalFromPrior(prior?.branches?.fraxlend, nowMs)),
    uniswapx: branch(ub.length ? "HOLD" : "REOPEN_CANDIDATE", ub, uRecords, ub.length ? [] : [loaded.ul.record?.sha256], observedAt, historicalFromPrior(prior?.branches?.uniswapx, nowMs)),
    valantis: branch(vb.length ? "HOLD" : "REOPEN_CANDIDATE", vb, vRecords, vb.length ? [] : [loaded.vl.record?.sha256], observedAt, historicalFromPrior(prior?.branches?.valantis, nowMs)),
  };
  branches.renzo.validUntil = rb.length ? null : rValidUntil;
  branches.fraxlend.validUntil = fb.length ? null : fValidUntil;
  branches.uniswapx.validUntil = ub.length ? null : uValidUntil;
  branches.valantis.validUntil = vb.length ? null : vValidUntil;
  const candidateValidities = BRANCHES.filter((name) => branches[name].status === "REOPEN_CANDIDATE").map((name) => branches[name].validUntil);
  const state = {
    branches, broadcast: false, fork: false, networkCalls: 0, observedAt,
    protectedInventoriesOpened: 0, providerMaterialAbsent: true, readOnly: true,
    schema: SCHEMA, signing: false,
    status: BRANCHES.some((name) => branches[name].status === "REOPEN_CANDIDATE") ? "REOPEN_CANDIDATE" : "HOLD",
    upstreamTransactions: 0,
    validUntil: candidateValidities.length ? conservativeValidUntil(candidateValidities) : null,
  };
  validateState(state, nowMs);
  return { state };
}

function validateEvidenceRow(row) {
  if (!exactKeys(row, ["path", "sha256"]) || !normalizeHash(row.sha256)) return false;
  try { evidenceRelative(row.path); return true; } catch { return false; }
}
function validateHistorical(row, nowMs) {
  if (!exactKeys(row, ["advisory", "expiresAt", "lineageDigests", "observedAt"]) || row.advisory !== HISTORICAL_ADVISORY
    || !validTime(row.observedAt) || !validTime(row.expiresAt) || Date.parse(row.observedAt) > nowMs
    || Date.parse(row.expiresAt) <= nowMs || Date.parse(row.expiresAt) - Date.parse(row.observedAt) !== HISTORY_TTL_MS
    || !Array.isArray(row.lineageDigests) || row.lineageDigests.some((x) => !normalizeHash(x))) return false;
  return true;
}
function validateState(state, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const top = ["branches", "broadcast", "fork", "networkCalls", "observedAt", "protectedInventoriesOpened", "providerMaterialAbsent", "readOnly", "schema", "signing", "status", "upstreamTransactions", "validUntil"];
  if (!Number.isFinite(nowMs) || !exactKeys(state, top) || state.schema !== SCHEMA || !validTime(state.observedAt)
    || Date.parse(state.observedAt) > nowMs || nowMs - Date.parse(state.observedAt) > MAX_EVIDENCE_AGE_MS
    || !new Set(["HOLD", "REOPEN_CANDIDATE"]).has(state.status)
    || state.readOnly !== true || state.upstreamTransactions !== 0 || state.signing !== false || state.broadcast !== false
    || state.fork !== false || state.networkCalls !== 0 || state.protectedInventoriesOpened !== 0 || state.providerMaterialAbsent !== true
    || !exactKeys(state.branches, BRANCHES)) fail("STATE_EXACT_SCHEMA_INVALID");
  const branchKeys = ["advisory", "blockers", "evidence", "lineageDigests", "observedAt", "priorValidatedObservation", "status", "validUntil"];
  for (const name of BRANCHES) {
    const row = state.branches[name];
    if (!exactKeys(row, branchKeys) || row.advisory !== ADVISORY || row.observedAt !== state.observedAt
      || !new Set(["HOLD", "REOPEN_CANDIDATE"]).has(row.status)
      || !Array.isArray(row.blockers) || canonicalJson(row.blockers) !== canonicalJson(sortedUnique(row.blockers))
      || row.blockers.some((x) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(x))
      || !Array.isArray(row.evidence) || row.evidence.some((x) => !validateEvidenceRow(x))
      || new Set(row.evidence.map((x) => x.path)).size !== row.evidence.length
      || !Array.isArray(row.lineageDigests) || row.lineageDigests.some((x) => !normalizeHash(x))
      || canonicalJson(row.lineageDigests) !== canonicalJson(sortedUnique(row.lineageDigests))
      || (row.status === "REOPEN_CANDIDATE" && row.blockers.length !== 0)
      || (row.status === "HOLD" && row.blockers.length === 0)
      || (row.status === "REOPEN_CANDIDATE" && (!validTime(row.validUntil) || Date.parse(row.validUntil) <= nowMs))
      || (row.status === "HOLD" && row.validUntil !== null)
      || (row.priorValidatedObservation !== null && !validateHistorical(row.priorValidatedObservation, nowMs))) fail("STATE_BRANCH_INVALID");
  }
  const expected = BRANCHES.some((name) => state.branches[name].status === "REOPEN_CANDIDATE") ? "REOPEN_CANDIDATE" : "HOLD";
  const expectedValidUntil = expected === "REOPEN_CANDIDATE"
    ? conservativeValidUntil(BRANCHES.filter((name) => state.branches[name].status === "REOPEN_CANDIDATE").map((name) => state.branches[name].validUntil)) : null;
  if (state.status !== expected || state.validUntil !== expectedValidUntil
    || (state.status === "REOPEN_CANDIDATE" && Date.parse(state.validUntil) <= nowMs)
    || (state.status === "HOLD" && state.validUntil !== null)
    || Buffer.byteLength(`${canonicalJson(state)}\n`) > MAX_STATE_BYTES) fail("STATE_INVALID");
  return true;
}

async function ensureOutputTarget(root, out = DEFAULT_OUTPUT) {
  const safe = outputRelative(out);
  const target = resolveWithin(root, safe);
  const parent = path.dirname(path.dirname(target.resolved));
  const parentSnapshot = await directorySnapshot(root, parent);
  const directory = path.dirname(target.resolved);
  try { await fsp.mkdir(directory); } catch (error) { if (error?.code !== "EEXIST") fail("PUBLICATION_TARGET_UNAVAILABLE"); }
  await revalidateDirectories(parentSnapshot);
  const directories = await directorySnapshot(root, directory);
  let existing = null;
  try {
    const stats = await fsp.lstat(target.resolved);
    if (!safeFileStats(stats, MAX_STATE_BYTES) || path.resolve(await fsp.realpath(target.resolved)) !== target.resolved) fail("PUBLICATION_TARGET_UNSAFE");
    existing = { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    if (error?.code !== "ENOENT") fail("PUBLICATION_TARGET_UNSAFE");
  }
  return { directory, directories, existing, output: target.resolved };
}
async function fsyncDirectory(directory) {
  try {
    const handle = await fsp.open(directory, fs.constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (process.platform !== "win32") fail("DIRECTORY_FSYNC_FAILED");
  }
}
async function assertDestinationUnchanged(target) {
  try {
    const stats = await fsp.lstat(target.output);
    if (!target.existing || !safeFileStats(stats, MAX_STATE_BYTES) || stats.dev !== target.existing.dev || stats.ino !== target.existing.ino) fail("PUBLICATION_DESTINATION_CHANGED");
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    if (error?.code !== "ENOENT" || target.existing) fail("PUBLICATION_DESTINATION_CHANGED");
  }
}
async function publishAtomic(root, state, out = DEFAULT_OUTPUT, dependencies = {}) {
  validateState(state, dependencies.now === undefined ? Date.now() : new Date(typeof dependencies.now === "function" ? dependencies.now() : dependencies.now).getTime());
  const encoded = Buffer.from(`${canonicalJson(state)}\n`, "utf8");
  const target = await ensureOutputTarget(root, out);
  const temporary = path.join(target.directory, `.blocked-branch-reopen.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporary, "wx", 0o600);
    await handle.writeFile(encoded);
    await handle.sync();
    const tempStats = await handle.stat();
    if (!safeFileStats(tempStats, MAX_STATE_BYTES)) fail("PUBLICATION_TEMP_UNSAFE");
    dependencies.onPublicationStage?.("temp-fsynced", temporary);
    await handle.close(); handle = null;
    await revalidateDirectories(target.directories);
    await assertDestinationUnchanged(target);
    dependencies.onPublicationStage?.("before-rename", target.output);
    await revalidateDirectories(target.directories);
    await assertDestinationUnchanged(target);
    await fsp.rename(temporary, target.output);
    const published = await fsp.lstat(target.output);
    if (!sameIdentity(tempStats, published) || !safeFileStats(published, MAX_STATE_BYTES)) fail("ATOMIC_REPLACEMENT_UNPROVEN");
    await fsyncDirectory(target.directory);
    dependencies.onPublicationStage?.("renamed", target.output);
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    fail("PUBLICATION_FAILED");
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
    encoded.fill(0);
  }
}

function lockPaths(root, out = DEFAULT_OUTPUT) {
  const target = resolveWithin(root, outputRelative(out));
  const directory = path.dirname(target.resolved);
  return { directory, canonical: path.join(directory, ".blocked-branch-reopen-monitor.lock") };
}
function validateLockOwner(owner) {
  if (!exactKeys(owner, ["createdAt", "expiresAt", "nonce", "pid"]) || !Number.isSafeInteger(owner.pid) || owner.pid < 1
    || !UUID.test(owner.nonce || "") || !validTime(owner.createdAt) || !validTime(owner.expiresAt)
    || Date.parse(owner.expiresAt) - Date.parse(owner.createdAt) !== LOCK_TTL_MS) fail("LOCK_OWNER_INVALID");
  return { createdAt: owner.createdAt, expiresAt: owner.expiresAt, nonce: owner.nonce.toLowerCase(), pid: owner.pid };
}
function sameOwner(a, b) { return a.pid === b.pid && a.nonce === b.nonce && a.createdAt === b.createdAt && a.expiresAt === b.expiresAt; }
function processDefinitelyDead(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === "ESRCH"; }
}
async function readOwnerAt(directory) {
  const stats = await fsp.lstat(directory);
  if (!safeDirectoryStats(stats)) fail("LOCK_UNSAFE");
  const ownerPath = path.join(directory, "owner.json");
  const file = await fsp.lstat(ownerPath);
  if (!safeFileStats(file, 2048)) fail("LOCK_OWNER_INVALID");
  const value = JSON.parse(await fsp.readFile(ownerPath, "utf8"));
  return validateLockOwner(value);
}
async function deleteVerifiedLockDirectory(directory, expected) {
  let actual;
  try { actual = await readOwnerAt(directory); } catch { return false; }
  if (!sameOwner(actual, expected)) return false;
  try {
    const entries = await fsp.readdir(directory);
    if (entries.length !== 1 || entries[0] !== "owner.json") return false;
    await fsp.unlink(path.join(directory, "owner.json"));
    await fsp.rmdir(directory);
    return true;
  } catch { return false; }
}
async function cleanStaleStaging(root, out, nowMs) {
  const paths = lockPaths(root, out);
  let names;
  try { names = await fsp.readdir(paths.directory); } catch { return 0; }
  const prefix = ".blocked-branch-reopen-monitor.lock.staging.";
  let cleaned = 0;
  for (const name of names.filter((x) => x.startsWith(prefix)).sort().slice(0, MAX_STAGING_SCAN)) {
    if (!/^\.blocked-branch-reopen-monitor\.lock\.staging\.[0-9]+\.[0-9a-f-]{36}$/i.test(name)) continue;
    const staging = path.join(paths.directory, name);
    let stats;
    try { stats = await fsp.lstat(staging); } catch { continue; }
    if (!safeDirectoryStats(stats) || nowMs - stats.mtimeMs <= LOCK_TTL_MS) continue;
    const quarantine = `${staging}.cleanup.${crypto.randomUUID()}`;
    try {
      await fsp.rename(staging, quarantine);
      const entries = await fsp.readdir(quarantine);
      if (entries.length === 0) { await fsp.rmdir(quarantine); cleaned += 1; continue; }
      if (entries.length === 1 && entries[0] === "owner.json") {
        const ownerPath = path.join(quarantine, "owner.json");
        const ownerStats = await fsp.lstat(ownerPath);
        if (safeFileStats(ownerStats, 2048)) { await fsp.unlink(ownerPath); await fsp.rmdir(quarantine); cleaned += 1; continue; }
      }
      // Unknown staging contents are quarantined, never deleted.
    } catch { /* bounded best effort */ }
  }
  return cleaned;
}
async function reclaimStaleCanonical(root, out, nowMs) {
  const paths = lockPaths(root, out);
  let owner;
  try { owner = await readOwnerAt(paths.canonical); } catch { return false; }
  if (Date.parse(owner.expiresAt) > nowMs || !processDefinitelyDead(owner.pid)) return false;
  const quarantine = `${paths.canonical}.stale.${owner.nonce}`;
  try {
    await fsp.rename(paths.canonical, quarantine);
    return await deleteVerifiedLockDirectory(quarantine, owner);
  } catch { return false; }
}
async function releaseOwnedLock(root, out, expected, dependencies = {}) {
  const owner = validateLockOwner(expected);
  const paths = lockPaths(root, out);
  let current;
  try { current = await readOwnerAt(paths.canonical); } catch { return false; }
  if (!sameOwner(current, owner)) return false;
  const quarantine = `${paths.canonical}.release.${owner.nonce}`;
  try {
    await fsp.rename(paths.canonical, quarantine);
    dependencies.afterReleaseRename?.(quarantine);
    return await deleteVerifiedLockDirectory(quarantine, owner);
  } catch { return false; }
}
async function acquireLock(root = ROOT, out = DEFAULT_OUTPUT, dependencies = {}) {
  await ensureOutputTarget(root, out);
  const suppliedNow = typeof dependencies.now === "function" ? dependencies.now() : dependencies.now;
  const nowMs = suppliedNow === undefined ? Date.now() : new Date(suppliedNow).getTime();
  if (!Number.isFinite(nowMs)) fail("TIME_INVALID");
  await cleanStaleStaging(root, out, nowMs);
  const paths = lockPaths(root, out);
  const owner = validateLockOwner(dependencies.ownership || { createdAt: isoNow(nowMs), expiresAt: isoNow(nowMs + LOCK_TTL_MS), nonce: crypto.randomUUID(), pid: process.pid });
  const staging = `${paths.canonical}.staging.${process.pid}.${owner.nonce}`;
  let created = false;
  try {
    await fsp.mkdir(staging); created = true;
    const handle = await fsp.open(path.join(staging, "owner.json"), "wx", 0o600);
    try { await handle.writeFile(`${canonicalJson(owner)}\n`); await handle.sync(); } finally { await handle.close(); }
    await fsyncDirectory(staging);
    try { await fsp.rename(staging, paths.canonical); }
    catch {
      if (await reclaimStaleCanonical(root, out, nowMs)) await fsp.rename(staging, paths.canonical);
      else fail("MONITOR_ALREADY_RUNNING");
    }
    await fsyncDirectory(paths.directory);
  } catch (error) {
    if (created) await deleteVerifiedLockDirectory(staging, owner).catch(() => false);
    if (error instanceof MonitorError) throw error;
    fail("LOCK_ACQUIRE_FAILED");
  }
  let released = false;
  return async () => {
    if (released) return false;
    released = true;
    return releaseOwnedLock(root, out, owner, dependencies.releaseDependencies || {});
  };
}

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")
    || argv.reduce((total, arg) => total + arg.length + 1, 0) > MAX_CLI_CHARS) fail("CLI_LENGTH_EXCEEDED");
  const options = { checkOnly: false, intervalSeconds: DEFAULT_INTERVAL_SECONDS, watch: false };
  let mode = null;
  const flags = {
    "--renzo-lineage-manifest": "renzoLineage", "--renzo-qualification-evidence": "renzoQualification",
    "--fraxlend-manifest": "fraxlendManifest", "--uniswapx-lineage-manifest": "uniswapxLineage",
    "--uniswapx-durability-evidence": "uniswapxDurability", "--local-storage-attestation": "localStorageAttestation",
    "--valantis-successor-lineage": "valantisLineage", "--valantis-finality-capability": "valantisCapability",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once" || arg === "--watch") {
      const next = arg.slice(2);
      if (mode && mode !== next) fail("MODE_CONFLICT");
      mode = next; options.watch = next === "watch";
    } else if (arg === "--check-only") options.checkOnly = true;
    else if (arg === "--interval-seconds") {
      const value = argv[++i];
      if (!/^[0-9]+$/.test(value || "")) fail("INTERVAL_INVALID");
      options.intervalSeconds = Number(value);
      if (!Number.isSafeInteger(options.intervalSeconds) || options.intervalSeconds < MIN_INTERVAL_SECONDS || options.intervalSeconds > MAX_INTERVAL_SECONDS) fail("INTERVAL_INVALID");
    } else if (flags[arg]) {
      const value = evidenceRelative(argv[++i]);
      if (options[flags[arg]]) fail("DUPLICATE_ARGUMENT");
      options[flags[arg]] = value;
    } else fail("UNKNOWN_ARGUMENT");
  }
  return options;
}
function publicSummary(state) {
  return { branches: Object.fromEntries(BRANCHES.map((name) => [name, state.branches[name].status])), networkCalls: 0, schema: SCHEMA, status: state.status, upstreamTransactions: 0, validUntil: state.validUntil };
}
async function runCycle(options, dependencies = {}, lockHeld = false) {
  const root = path.resolve(dependencies.root || ROOT);
  const out = outputRelative(dependencies.outputRelative || DEFAULT_OUTPUT);
  let release = async () => true;
  if (!options.checkOnly && !lockHeld) release = await (dependencies.acquireLock || acquireLock)(root, out, dependencies.lockDependencies || {});
  try {
    const result = await evaluate(options, dependencies);
    if (!options.checkOnly) await (dependencies.publishState || publishAtomic)(root, result.state, out, dependencies.publicationDependencies || {});
    return result;
  } finally { await release(); }
}
async function runWatch(options, dependencies, release) {
  const signalTarget = dependencies.signalTarget || process;
  const write = dependencies.writeStdout || ((text) => process.stdout.write(text));
  const sleep = dependencies.sleep || ((ms, register) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); register(() => { clearTimeout(timer); resolve(); }); }));
  let stopping = false;
  let wake = () => {};
  const stop = () => { stopping = true; wake(); };
  signalTarget.once("SIGINT", stop); signalTarget.once("SIGTERM", stop);
  try {
    while (!stopping) {
      try { const result = await runCycle(options, dependencies, true); write(`${canonicalJson(publicSummary(result.state))}\n`); }
      catch { write(`${canonicalJson({ errorClass: "ATTEMPT_FAILED", schema: SCHEMA, status: "HOLD" })}\n`); }
      if (stopping) break;
      await sleep(options.intervalSeconds * 1000, (callback) => { wake = callback; }); wake = () => {};
    }
  } finally { signalTarget.removeListener("SIGINT", stop); signalTarget.removeListener("SIGTERM", stop); await release(); }
}
async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const write = dependencies.writeStdout || ((text) => process.stdout.write(text));
  let options;
  try { options = parseCli(argv); }
  catch (error) {
    write(`${canonicalJson({ errorClass: error instanceof MonitorError ? error.code : "CLI_INVALID", schema: SCHEMA, status: "HOLD" })}\n`);
    return { exitCode: 2 };
  }
  const root = path.resolve(dependencies.root || ROOT);
  const out = outputRelative(dependencies.outputRelative || DEFAULT_OUTPUT);
  let release = async () => true;
  try {
    if (!options.checkOnly) release = await (dependencies.acquireLock || acquireLock)(root, out, dependencies.lockDependencies || {});
    if (options.watch) { await runWatch(options, dependencies, release); return { exitCode: 0 }; }
    try {
      const result = await runCycle(options, dependencies, true);
      write(`${canonicalJson(publicSummary(result.state))}\n`);
      return { exitCode: 0, ...result };
    } finally { await release(); }
  } catch (error) {
    await release().catch(() => {});
    write(`${canonicalJson({ errorClass: error instanceof MonitorError ? error.code : "LOCAL_FAILURE", schema: SCHEMA, status: "HOLD" })}\n`);
    return { exitCode: 1 };
  }
}

if (require.main === module) runCli().then((result) => { process.exitCode = result.exitCode; }).catch(() => {
  process.stdout.write(`${canonicalJson({ errorClass: "LOCAL_FAILURE", schema: SCHEMA, status: "HOLD" })}\n`); process.exitCode = 1;
});

module.exports = {
  SCHEMA, EVIDENCE_ROOT, DEFAULT_OUTPUT, DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS,
  MAX_EVIDENCE_AGE_MS, HISTORY_TTL_MS, LOCK_TTL_MS, MAX_CLI_CHARS, MAX_PATH_CHARS,
  MAX_SEGMENT_CHARS, MAX_DESCRIPTOR_ARRAY_COUNT, MAX_DESCRIPTORS_PER_BRANCH,
  MAX_DESCRIPTORS_PER_CYCLE, MAX_CYCLE_READ_BYTES, MAX_POSITIONAL_READ_BYTES, ADVISORY, HISTORICAL_ADVISORY,
  CONSUMED_RENZO_HASHES, CONSUMED_UNISWAPX_HASHES, CONSUMED_VALANTIS_HASHES, VALANTIS_PREDECESSOR,
  MonitorError, ReadBudget, canonicalJson, sha256,
  portableRelative, evidenceRelative, readSafeBytes, readSafeJson, validateRenzoLineage,
  validateRenzoQualification, validateFraxlend, validateUniswapxLineage, validateUniswapxDurability,
  validateValantisLineage, validateValantisCapability, validateLocalStorageAttestation,
  validateState, evaluate, publishAtomic, acquireLock, releaseOwnedLock, cleanStaleStaging,
  parseCli, runCycle, runWatch, runCli,
  _test: { exactKeys, descriptorShape, ensureOutputTarget, validateLockOwner, readOwnerAt, publicSummary },
};
