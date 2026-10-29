#!/usr/bin/env node
"use strict";

// Package validation is intentionally outside the comparator core below. The
// core has no filesystem, process, Docker, or network capability.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const NAMESPACE = "profitable-async-liability-solidity-builder-exit-inspect-comparator-v15";
const STATUS = "SEALED_OFFLINE_EXIT_INSPECT_COMPARATOR_REVIEW_REQUIRED_NO_EXECUTION_AUTHORITY";
const RESERVED_FLAG = "--execute-v15";
const ZERO_TIME = "0001-01-01T00:00:00Z";

const MISMATCH_CODES = Object.freeze([
  "CAUSAL_ID_MISMATCH",
  "EXPECTED_MALFORMED",
  "EXTRA_PAL_LABEL",
  "LABELS_MALFORMED",
  "LABEL_MISSING",
  "LABEL_VALUE_MISMATCH",
  "NAME_MISMATCH",
  "RAW_MALFORMED",
  "ROWS_MALFORMED",
  "STATE_EXIT_CODE_MISMATCH",
  "STATE_FINISHED_AT_INVALID",
  "STATE_RUNNING_MISMATCH",
  "STATE_STARTED_AT_INVALID",
  "STATE_STATUS_MISMATCH",
  "STATE_TIMESTAMP_ORDER_INVALID"
]);
const REPRESENTATION_NOTES = Object.freeze(["EXTRA_NON_PAL_LABELS_PRESENT"]);

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function exactKeys(value, keys) { return object(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys); }
function bounded(codes, notes) {
  const mismatchCodes = [...new Set(codes.filter((x) => MISMATCH_CODES.includes(x)))].sort();
  const representationNotes = [...new Set(notes.filter((x) => REPRESENTATION_NOTES.includes(x)))].sort();
  return Object.freeze({ match: mismatchCodes.length === 0, mismatchCodes: Object.freeze(mismatchCodes), representationNotes: Object.freeze(representationNotes) });
}
function expectedValid(expected) {
  if (!exactKeys(expected, ["id", "name", "labels"]) || typeof expected.id !== "string" || typeof expected.name !== "string" || !object(expected.labels)) return false;
  const labels = Object.keys(expected.labels);
  return labels.length > 0 && labels.every((key) => key.startsWith("pal.") && typeof expected.labels[key] === "string");
}

// Howard Hinnant's civil-date conversion, translated to BigInt. The absolute
// epoch is immaterial; using BigInt preserves all nine fractional digits.
function daysFromCivil(year, month, day) {
  let y = BigInt(year), m = BigInt(month), d = BigInt(day);
  y -= m <= 2n ? 1n : 0n;
  const era = y >= 0n ? y / 400n : (y - 399n) / 400n;
  const yoe = y - era * 400n;
  const mp = m + (m > 2n ? -3n : 9n);
  const doy = (153n * mp + 2n) / 5n + d - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146097n + doe;
}
function leap(year) { return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); }

/** Parse only RFC3339Nano UTC-Z timestamps. Returns a nanosecond BigInt or null. */
function parseRfc3339NanoUtc(value) {
  if (typeof value !== "string" || value === ZERO_TIME) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]), hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const monthDays = [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
  const fraction = BigInt((match[7] || "").padEnd(9, "0") || "0");
  if (year === 1 && month === 1 && day === 1 && hour === 0 && minute === 0 && second === 0 && fraction === 0n) return null;
  return (((daysFromCivil(year, month, day) * 24n + BigInt(hour)) * 60n + BigInt(minute)) * 60n + BigInt(second)) * 1000000000n + fraction;
}

/** Pure comparison of one already-decoded Docker inspect row. Never throws. */
function compareExitInspect(raw, expected) {
  try { if (!expectedValid(expected)) return bounded(["EXPECTED_MALFORMED"], []); }
  catch { return bounded(["EXPECTED_MALFORMED"], []); }
  try {
    if (!object(raw)) return bounded(["RAW_MALFORMED"], []);
    const codes = [], notes = [];
    if (raw.Id !== expected.id) codes.push("CAUSAL_ID_MISMATCH");
    if (raw.Name !== expected.name) codes.push("NAME_MISMATCH");

    const labels = object(raw.Config) ? raw.Config.Labels : undefined;
    if (!object(labels) || Object.keys(labels).some((key) => typeof labels[key] !== "string")) codes.push("LABELS_MALFORMED");
    else {
      for (const [key, value] of Object.entries(expected.labels)) {
        if (!own(labels, key)) codes.push("LABEL_MISSING");
        else if (labels[key] !== value) codes.push("LABEL_VALUE_MISMATCH");
      }
      const extras = Object.keys(labels).filter((key) => !own(expected.labels, key));
      if (extras.some((key) => key.startsWith("pal."))) codes.push("EXTRA_PAL_LABEL");
      if (extras.some((key) => !key.startsWith("pal."))) notes.push("EXTRA_NON_PAL_LABELS_PRESENT");
    }

    const state = object(raw.State) ? raw.State : {};
    if (state.Status !== "exited") codes.push("STATE_STATUS_MISMATCH");
    if (state.Running !== false) codes.push("STATE_RUNNING_MISMATCH");
    if (!Number.isInteger(state.ExitCode) || state.ExitCode !== 0) codes.push("STATE_EXIT_CODE_MISMATCH");
    const started = parseRfc3339NanoUtc(state.StartedAt), finished = parseRfc3339NanoUtc(state.FinishedAt);
    if (started === null) codes.push("STATE_STARTED_AT_INVALID");
    if (finished === null) codes.push("STATE_FINISHED_AT_INVALID");
    if (started !== null && finished !== null && finished < started) codes.push("STATE_TIMESTAMP_ORDER_INVALID");
    return bounded(codes, notes);
  } catch {
    return bounded(["RAW_MALFORMED"], []);
  }
}

/** Pure JSON/rows adapter. Exactly one array row is required. Never throws. */
function compareExitInspectRows(input, expected) {
  try {
    const rows = typeof input === "string" ? JSON.parse(input) : input;
    if (!Array.isArray(rows) || rows.length !== 1 || !object(rows[0])) return bounded(["ROWS_MALFORMED"], []);
    return compareExitInspect(rows[0], expected);
  } catch {
    return bounded(["ROWS_MALFORMED"], []);
  }
}

// ---- Sealed package validation (offline filesystem integrity only) ----
const V14 = "profitable-async-liability-solidity-builder-host-mount-two-build-executor-v14-production-v1";
const V13 = "profitable-async-liability-solidity-builder-host-mount-comparator-v13";
const RUN_ID = "40b10a8f8ae2992090b8e3dc3bcb5bf5";
const SUCCESSOR_PATHS = Object.freeze([
  `tools/run-${NAMESPACE}.js`, `tools/test-run-${NAMESPACE}.js`, `reports/${NAMESPACE}.md`, `tools/vendor/${NAMESPACE}/planned-successor-policy.json`
]);
const V14_PACKAGE_PATHS = Object.freeze([
  `tools/vendor/${V14}/manifests/package-manifest.json`, `tools/vendor/${V14}/manifests/authority-manifest.json`, `tools/vendor/${V14}/manifests/authority-manifest.sha256`
]);
const V14_AUTHORITY_CHAIN_PATHS = Object.freeze([
  `tools/vendor/${V14}-execution-authorization/execution-authorization.json`, `tools/vendor/${V14}-execution-authorization/authority-manifest.json`, `tools/vendor/${V14}-execution-authorization/authority-manifest.sha256`,
  `tools/vendor/${V14}-review-decision/review-decision.json`, `tools/vendor/${V14}-review-decision/authority-manifest.json`, `tools/vendor/${V14}-review-decision/authority-manifest.sha256`,
  `tools/vendor/${V14}-final-authority/final-execution-authority.json`, `tools/vendor/${V14}-final-authority/authority-manifest.json`, `tools/vendor/${V14}-final-authority/authority-manifest.sha256`
]);
const V14_TERMINAL_PATHS = Object.freeze([
  `tools/vendor/${V14}/runs/${RUN_ID}/authorization-consumed.json`, `tools/vendor/${V14}/runs/${RUN_ID}/journal.jsonl`, `tools/vendor/${V14}/runs/${RUN_ID}/failure.json`
]);
const V13_PACKAGE_PATHS = Object.freeze([
  `tools/run-${V13}.js`, `tools/test-run-${V13}.js`, `reports/${V13}.md`, `tools/vendor/${V13}/planned-successor-policy.json`,
  `tools/vendor/${V13}/manifests/package-manifest.json`, `tools/vendor/${V13}/manifests/authority-manifest.json`, `tools/vendor/${V13}/manifests/authority-manifest.sha256`
]);
const GROUP_KEYS = Object.freeze(["successorRecords", "v14PackageAuthorityDetachedRecords", "v14AuthorityChainRecords", "v14TerminalRecords", "v13PackageRecords", "v13FullLineageRecords"]);
const GROUP_COUNTS = Object.freeze([4, 3, 9, 3, 7, 143]);
const CAPABILITIES = Object.freeze({ filesystem: false, process: false, network: false, docker: false, inventory: false, execution: false, dropInExecution: false });
const CLAIMS = Object.freeze({ exactV14ExitMismatchField: false, labelDefectProven: false, timestampDefectProven: false, execution: false, reinspect: false, build: false, equality: false, reproducibility: false, parserPromotion: false, detectorRun: false });

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function aggregate(paths) { return sha256(Buffer.from(paths.join("\n"))); }
function equal(actual, expected) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("PACKAGE_INVALID"); }
function recordFor(workspace, relative) { const bytes = fs.readFileSync(path.join(workspace, ...relative.split("/"))); return { path: relative, bytes: bytes.length, sha256: sha256(bytes) }; }
function recordValid(record) { return exactKeys(record, ["path", "bytes", "sha256"]) && typeof record.path === "string" && Number.isSafeInteger(record.bytes) && record.bytes >= 0 && /^[a-f0-9]{64}$/.test(record.sha256); }
function validatePolicy(policy) {
  if (!exactKeys(policy, ["schema", "status", "executionAuthorized", "comparator", "input", "output", "futureExecutor", "claims"])) throw new Error("PACKAGE_INVALID");
  equal(policy, {
    schema: `${NAMESPACE}/planned-successor-policy-v1`, status: "OFFLINE_PLAN_EXECUTION_UNAUTHORIZED", executionAuthorized: false,
    comparator: "PURE_IN_MEMORY_EXIT_INSPECT_COMPARATOR", input: "EXISTING_POST_START_ONE_ROW_INSPECT_ONLY", output: ["match", "mismatchCodes", "representationNotes"],
    futureExecutor: { distinctReviewedSuccessorRequired: true, existingPostStartInspectOnly: true, extraInspect: false, inventory: false, retry: false, fallback: false, exactCausalCleanupOnMismatch: true, terminalNoRetry: true, persistBoundedComparatorEvidenceOnly: true, persistRawInspect: false, persistRawValues: false },
    claims: CLAIMS
  });
  return true;
}
function validatePackageObjects(manifest, authority, policy, detached, source) {
  const manifestKeys = ["schema", "namespace", "status", "executionAuthorized", "capabilities", "diagnosis", "excludedRecords", ...GROUP_KEYS, "v13FullLineageCount", "v13FullLineagePathAggregateSha256", "plannedSuccessorPolicy", "claims"];
  const authorityKeys = ["schema", "namespace", "status", "executionAuthorized", "reservedFlag", "runner", "tests", "report", "plannedSuccessorPolicy", "packageManifest", "v14PackageAuthorityDetached", "v14AuthorityChain", "v14Terminal", "v13Package", "v13FullLineageCount", "v13FullLineagePathAggregateSha256", "capabilities", "claims", "detachedChecksumRole"];
  if (!exactKeys(manifest, manifestKeys) || !exactKeys(authority, authorityKeys)) throw new Error("PACKAGE_INVALID");
  validatePolicy(policy);
  if (manifest.schema !== `${NAMESPACE}/package-manifest-v1` || manifest.namespace !== NAMESPACE || manifest.status !== STATUS || manifest.executionAuthorized !== false) throw new Error("PACKAGE_INVALID");
  equal(manifest.capabilities, CAPABILITIES); equal(manifest.claims, CLAIMS);
  equal(manifest.diagnosis, { v14AuthorizationId: RUN_ID, createdInspectStatus: "MATCH_WITH_REPRESENTATION_NOTE", createdInspectRepresentationNotes: ["ENV_ORDER_ONLY", "EXTRA_NON_PAL_LABELS_PRESENT"], startAttachProcessStatus: 0, exitedInspectProcessStatus: 0, terminalCode: "EXIT_INSPECT_FAILED", exactMismatchField: "UNKNOWN_RAW_EXIT_INSPECT_NOT_RETAINED", strongestHypotheses: ["EXACT_LABEL_EQUALITY_REJECTED_DOCKER_ADDED_NON_PAL_LABEL", "TIMESTAMP_VALIDATION_LATENT"], labelHypothesisLikely: true, labelHypothesisProven: false, timestampHypothesisProven: false, dockerConfigurationSameAcrossCreatedAndExitedInspect: true });
  equal(manifest.excludedRecords, [`tools/vendor/${V14}/runs/${RUN_ID}/docker-config/config.json`, "RAW_EXIT_INSPECT_NOT_RETAINED"]);
  const paths = [SUCCESSOR_PATHS, V14_PACKAGE_PATHS, V14_AUTHORITY_CHAIN_PATHS, V14_TERMINAL_PATHS, V13_PACKAGE_PATHS, source.v13Lineage.map((x) => x.path)];
  GROUP_KEYS.forEach((key, i) => { if (!Array.isArray(manifest[key]) || manifest[key].length !== GROUP_COUNTS[i]) throw new Error("PACKAGE_INVALID"); equal(manifest[key].map((x) => x.path), paths[i]); manifest[key].forEach((x) => { if (!recordValid(x)) throw new Error("PACKAGE_INVALID"); }); });
  equal(manifest.v14PackageAuthorityDetachedRecords, source.v14Package); equal(manifest.v14AuthorityChainRecords, source.v14Chain); equal(manifest.v14TerminalRecords, source.v14Terminal); equal(manifest.v13PackageRecords, source.v13Package); equal(manifest.v13FullLineageRecords, source.v13Lineage);
  const all = GROUP_KEYS.flatMap((key) => manifest[key]); if (new Set(all.map((x) => x.path)).size !== all.length) throw new Error("PACKAGE_INVALID");
  if (manifest.v13FullLineageCount !== 143 || manifest.v13FullLineagePathAggregateSha256 !== source.v13Aggregate || aggregate(manifest.v13FullLineageRecords.map((x) => x.path)) !== source.v13Aggregate) throw new Error("PACKAGE_INVALID");
  equal(manifest.plannedSuccessorPolicy, manifest.successorRecords[3]);
  if (authority.schema !== `${NAMESPACE}/authority-v1` || authority.namespace !== NAMESPACE || authority.status !== STATUS || authority.executionAuthorized !== false || authority.reservedFlag !== RESERVED_FLAG || authority.detachedChecksumRole !== "INTEGRITY_ONLY_NOT_EXECUTION_AUTHORITY") throw new Error("PACKAGE_INVALID");
  equal(authority.capabilities, CAPABILITIES); equal(authority.claims, CLAIMS);
  [authority.runner, authority.tests, authority.report, authority.plannedSuccessorPolicy, authority.packageManifest].forEach((x) => { if (!recordValid(x)) throw new Error("PACKAGE_INVALID"); });
  equal([authority.runner, authority.tests, authority.report, authority.plannedSuccessorPolicy], manifest.successorRecords);
  equal(authority.v14PackageAuthorityDetached, manifest.v14PackageAuthorityDetachedRecords); equal(authority.v14AuthorityChain, manifest.v14AuthorityChainRecords); equal(authority.v14Terminal, manifest.v14TerminalRecords); equal(authority.v13Package, manifest.v13PackageRecords);
  if (authority.packageManifest.path !== `tools/vendor/${NAMESPACE}/manifests/package-manifest.json` || authority.v13FullLineageCount !== 143 || authority.v13FullLineagePathAggregateSha256 !== source.v13Aggregate) throw new Error("PACKAGE_INVALID");
  if (detached !== `${source.authoritySha256}  authority-manifest.json\n`) throw new Error("PACKAGE_INVALID");
  return true;
}
function validateTopology(rootChildren, manifestChildren) {
  equal([...rootChildren].sort(), ["manifests", "planned-successor-policy.json"]);
  equal([...manifestChildren].sort(), ["authority-manifest.json", "authority-manifest.sha256", "package-manifest.json"]);
  return true;
}
function validatePackage(workspace = path.join(__dirname, "..")) {
  const root = path.join(workspace, "tools", "vendor", NAMESPACE), manifests = path.join(root, "manifests");
  validateTopology(fs.readdirSync(root), fs.readdirSync(manifests));
  const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(workspace, ...relative.split("/")), "utf8"));
  const packagePath = `tools/vendor/${NAMESPACE}/manifests/package-manifest.json`, authorityPath = `tools/vendor/${NAMESPACE}/manifests/authority-manifest.json`;
  const manifest = readJson(packagePath), authorityBytes = fs.readFileSync(path.join(workspace, ...authorityPath.split("/"))), authority = JSON.parse(authorityBytes), policy = readJson(SUCCESSOR_PATHS[3]);
  const v14Manifest = readJson(V14_PACKAGE_PATHS[0]);
  // V14 already seals V13's complete 143-record lineage in exact order.
  const sealedLineage = v14Manifest.v13FlattenedPredecessorRecords;
  if (!Array.isArray(sealedLineage)) throw new Error("PACKAGE_INVALID");
  const source = { v14Package: V14_PACKAGE_PATHS.map((x) => recordFor(workspace, x)), v14Chain: V14_AUTHORITY_CHAIN_PATHS.map((x) => recordFor(workspace, x)), v14Terminal: V14_TERMINAL_PATHS.map((x) => recordFor(workspace, x)), v13Package: V13_PACKAGE_PATHS.map((x) => recordFor(workspace, x)), v13Lineage: sealedLineage, v13Aggregate: v14Manifest.v13FlattenedPredecessorPathAggregateSha256, authoritySha256: sha256(authorityBytes) };
  validatePackageObjects(manifest, authority, policy, fs.readFileSync(path.join(manifests, "authority-manifest.sha256"), "utf8"), source);
  for (const item of GROUP_KEYS.flatMap((key) => manifest[key])) equal(item, recordFor(workspace, item.path)); equal(authority.packageManifest, recordFor(workspace, packagePath));
  return Object.freeze({ manifest, authority, policy });
}

function main(argv) {
  if (!Array.isArray(argv)) throw new Error("ARGUMENTS_REJECTED");
  if (argv.length === 0) { validatePackage(); return { schema: `${NAMESPACE}/offline-summary-v1`, status: "PASS", packageStatus: STATUS, executionAuthorized: false, processCalls: 0, writes: 0 }; }
  if (argv.length === 1 && argv[0] === RESERVED_FLAG) throw new Error("V15_NO_EXECUTION_AUTHORITY");
  throw new Error("ARGUMENTS_REJECTED");
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: error.message, executionAuthorized: false, processCalls: 0, writes: 0 })}\n`); process.exitCode = 1; }
}

module.exports = Object.freeze({ NAMESPACE, STATUS, RESERVED_FLAG, ZERO_TIME, MISMATCH_CODES, REPRESENTATION_NOTES, GROUP_KEYS, GROUP_COUNTS, compareExitInspect, compareExitInspectRows, parseRfc3339NanoUtc, validatePolicy, validatePackageObjects, validateTopology, validatePackage, aggregate, main });
