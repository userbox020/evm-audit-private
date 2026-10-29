#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TARGET_ROOT = path.join(ROOT, "targets/derive-v2-core");
const MANIFEST_REL = "reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1-manifest.json";
const MANIFEST_PATH = path.join(ROOT, ...MANIFEST_REL.split("/"));
const RAW_PATH = path.join(ROOT, "reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1.json");
const METADATA_PATH = path.join(ROOT, "reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1-compiled-metadata.json");
const REPORT_PATH = path.join(ROOT, "reports/critical-derive-v2-cash-wrapped-pnl-funding-conservation-step1.md");
const INBOX_PATH = path.join(ROOT, "coordination/inbox/critical/20260728-critical-derive-v2-cash-wrapped-pnl-funding-step1.json");
const HANDOFF_PATH = path.join(ROOT, "coordination/handoffs/20260728-critical-derive-v2-cash-wrapped-pnl-funding-step1-handoff.md");
const ALGORITHM =
  "sha256(UTF-8 JSON.stringify(records sorted ascending by unsigned ordinal UTF-8 bytes of POSIX path; record key order path,sha256,bytes; no extra whitespace))";
const EXPECTED_PATHS = [
  "reports/critical-derive-v2-cash-wrapped-pnl-funding-conservation-step1.md",
  "reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1-build.txt",
  "reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1-compiled-metadata.json",
  "reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1-forge-focused.txt",
  "reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1-forge-relevant.txt",
  "reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1.json",
  "targets/derive-v2-core/test/audit/DeriveV2CashWrappedConservationStep1.t.sol",
  "targets/derive-v2-core/test/audit/DeriveV2PnlFundingInterestConservationStep1.t.sol",
  "tools/generate-critical-derive-v2-step1-manifest.js",
  "tools/validate-critical-derive-v2-step1.js",
];

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function comparePaths(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function assertPortablePath(recordPath) {
  check(typeof recordPath === "string" && recordPath.length > 0, `invalid path: ${recordPath}`);
  check(!recordPath.includes("\\"), `path is not POSIX-normalized: ${recordPath}`);
  check(!path.posix.isAbsolute(recordPath) && path.posix.normalize(recordPath) === recordPath && !recordPath.startsWith("../"), `path is not normalized relative POSIX: ${recordPath}`);
}

const manifestBytes = fs.readFileSync(MANIFEST_PATH);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
check(manifest.aggregateAlgorithm === ALGORITHM, "manifest aggregate algorithm mismatch");
check(manifest.pathComparator === "ascending unsigned ordinal comparison of UTF-8 encoded normalized relative POSIX path bytes using Node.js Buffer.compare", "manifest path comparator mismatch");
check(Array.isArray(manifest.records) && manifest.recordCount === EXPECTED_PATHS.length && manifest.records.length === EXPECTED_PATHS.length, "manifest record count mismatch");

const expectedSorted = [...EXPECTED_PATHS].sort(comparePaths);
const actualPaths = manifest.records.map((record) => record.path);
check(JSON.stringify(actualPaths) === JSON.stringify(expectedSorted), "manifest records are not in deterministic unsigned ordinal UTF-8 POSIX-path order");
const seen = new Set();
for (const record of manifest.records) {
  assertPortablePath(record.path);
  check(!seen.has(record.path), `duplicate manifest record: ${record.path}`);
  seen.add(record.path);
  check(Object.keys(record).join(",") === "path,sha256,bytes", `manifest record key order mismatch: ${record.path}`);
  check(Number.isSafeInteger(record.bytes) && record.bytes >= 0, `invalid manifest byte count: ${record.path}`);
  check(/^[0-9a-f]{64}$/.test(record.sha256), `invalid manifest SHA-256: ${record.path}`);
  const exactBytes = fs.readFileSync(path.join(ROOT, ...record.path.split("/")));
  check(exactBytes.length === record.bytes, `manifest byte count mismatch: ${record.path}`);
  check(sha256(exactBytes) === record.sha256, `manifest SHA-256 mismatch: ${record.path}`);
}
const aggregateSha256 = sha256(Buffer.from(JSON.stringify(manifest.records), "utf8"));
check(aggregateSha256 === manifest.aggregateSha256, "manifest aggregate SHA-256 mismatch");

const raw = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
check(raw.manifestAggregateAlgorithm === ALGORITHM, "raw aggregate algorithm mismatch");
check(raw.finding.codeReferences.includes("src/assets/InterestRateModel.sol:69-91,104-111"), "raw InterestRateModel citation mismatch");
check(raw.finding.codeReferences.includes("src/assets/PerpAsset.sol:215-221,481-484"), "raw PerpAsset citation mismatch");
for (const [recordPath, expectedHash] of Object.entries(raw.sourceProvenanceSha256)) {
  assertPortablePath(recordPath);
  const exactBytes = fs.readFileSync(path.join(TARGET_ROOT, ...recordPath.split("/")));
  check(sha256(exactBytes) === expectedHash, `source provenance SHA-256 mismatch: ${recordPath}`);
}
for (const [recordPath, expectedHash] of Object.entries(raw.deploymentProvenanceSha256)) {
  assertPortablePath(recordPath);
  const exactBytes = fs.readFileSync(path.join(TARGET_ROOT, ...recordPath.split("/")));
  check(sha256(exactBytes) === expectedHash, `deployment provenance SHA-256 mismatch: ${recordPath}`);
}

const metadata = JSON.parse(fs.readFileSync(METADATA_PATH, "utf8"));
for (const artifact of metadata.artifacts) {
  const artifactPath = path.join(TARGET_ROOT, "out", `${artifact.contract}.sol`, `${artifact.contract}.json`);
  const artifactBytes = fs.readFileSync(artifactPath);
  check(sha256(artifactBytes) === artifact.artifactSha256, `artifact SHA-256 mismatch: ${artifact.contract}`);
  const parsed = JSON.parse(artifactBytes.toString("utf8"));
  const object = parsed.deployedBytecode.object;
  if (/^0x[0-9a-fA-F]*$/.test(object)) {
    const hex = object.slice(2);
    check(hex.length % 2 === 0, `odd runtime hex length: ${artifact.contract}`);
    const runtimeBytes = Buffer.from(hex, "hex");
    check(runtimeBytes.length === artifact.runtimeBytes, `runtime byte count mismatch: ${artifact.contract}`);
    check(sha256(runtimeBytes) === artifact.runtimeDecodedSha256, `runtime SHA-256 mismatch: ${artifact.contract}`);
  } else {
    check(artifact.runtimeBytes === null && artifact.runtimeDecodedSha256 === null, `unresolved runtime must use nulls: ${artifact.contract}`);
  }
}

const report = fs.readFileSync(REPORT_PATH, "utf8");
check(report.includes(ALGORITHM), "report aggregate algorithm wording mismatch");
check(report.includes("`src/assets/InterestRateModel.sol:69-91,104-111`"), "report InterestRateModel citation mismatch");
check(report.includes("`src/assets/PerpAsset.sol:215-221,481-484`"), "report PerpAsset citation mismatch");
check(!report.includes("InterestRateModel.sol:53-68") && !report.includes("PerpAsset.sol:230-255"), "stale report citation remains");

const manifestSha256 = sha256(manifestBytes);
const inbox = JSON.parse(fs.readFileSync(INBOX_PATH, "utf8"));
check(inbox.aggregateAlgorithm === ALGORITHM, "inbox aggregate algorithm mismatch");
check(inbox.manifestAggregate === aggregateSha256, "inbox aggregate reference mismatch");
check(inbox.manifestSha256 === manifestSha256, "inbox manifest reference mismatch");
const handoff = fs.readFileSync(HANDOFF_PATH, "utf8");
check(handoff.includes(ALGORITHM), "handoff aggregate algorithm mismatch");
check(handoff.includes(aggregateSha256), "handoff aggregate reference mismatch");
check(handoff.includes(manifestSha256), "handoff manifest reference mismatch");

process.stdout.write(`${JSON.stringify({ ok: true, mode: "check-only", checks, comparator: ALGORITHM, recordCount: manifest.recordCount, aggregateSha256, manifestSha256 })}\n`);
