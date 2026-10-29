#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(
  ROOT,
  "reports/raw/fast/critical-derive-v2-cash-wrapped-pnl-funding-step1-manifest.json",
);
const ALGORITHM =
  "sha256(UTF-8 JSON.stringify(records sorted ascending by unsigned ordinal UTF-8 bytes of POSIX path; record key order path,sha256,bytes; no extra whitespace))";
const RECORD_PATHS = [
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

function fail(message) {
  throw new Error(message);
}

function assertPortablePath(recordPath) {
  if (typeof recordPath !== "string" || recordPath.length === 0) fail("record path must be a nonempty string");
  if (recordPath.includes("\\")) fail(`record path is not POSIX-normalized: ${recordPath}`);
  if (path.posix.isAbsolute(recordPath) || path.posix.normalize(recordPath) !== recordPath || recordPath.startsWith("../")) {
    fail(`record path is not a normalized relative POSIX path: ${recordPath}`);
  }
}

function compareRecords(a, b) {
  return Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const seen = new Set();
const records = RECORD_PATHS.map((recordPath) => {
  assertPortablePath(recordPath);
  if (seen.has(recordPath)) fail(`duplicate record path: ${recordPath}`);
  seen.add(recordPath);
  const bytes = fs.readFileSync(path.join(ROOT, ...recordPath.split("/")));
  return { path: recordPath, sha256: sha256(bytes), bytes: bytes.length };
}).sort(compareRecords);

const aggregateSha256 = sha256(Buffer.from(JSON.stringify(records), "utf8"));
const manifest = {
  schemaVersion: 4,
  generatedAt: "2026-07-28T11:42:56.737Z",
  commit: "96796a61dcb1dc852e25518b00cc1a79fb3caeeb",
  aggregateAlgorithm: ALGORITHM,
  pathComparator: "ascending unsigned ordinal comparison of UTF-8 encoded normalized relative POSIX path bytes using Node.js Buffer.compare",
  recordCount: records.length,
  aggregateSha256,
  records,
  purity: { network: 0, rpc: 0, endpoints: 0, secrets: 0, fork: 0, signedTransactions: 0, broadcasts: 0, liveActions: 0 },
};

fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const manifestSha256 = sha256(fs.readFileSync(MANIFEST_PATH));
process.stdout.write(`${JSON.stringify({ comparator: ALGORITHM, recordCount: records.length, aggregateSha256, manifestSha256 })}\n`);
