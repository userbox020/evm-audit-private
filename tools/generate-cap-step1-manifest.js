#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(
  ROOT,
  "reports/raw/fast/critical-cap-mixed-asset-conservation-step1-manifest.json",
);
const ALGORITHM =
  "sha256(UTF-8 JSON.stringify(records sorted ascending by unsigned ordinal UTF-8 bytes of POSIX path; record key order path,sha256,bytes; no extra whitespace))";

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

const previous = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
if (!Array.isArray(previous.records) || previous.records.length !== 39) fail("expected exactly 39 prior records");

const seen = new Set();
const records = previous.records.map(({ path: recordPath }) => {
  assertPortablePath(recordPath);
  if (seen.has(recordPath)) fail(`duplicate record path: ${recordPath}`);
  seen.add(recordPath);
  const bytes = fs.readFileSync(path.join(ROOT, ...recordPath.split("/")));
  return { path: recordPath, sha256: sha256(bytes), bytes: bytes.length };
}).sort(compareRecords);

const aggregateSha256 = sha256(Buffer.from(JSON.stringify(records), "utf8"));
const manifest = {
  schemaVersion: 2,
  generatedAt: previous.generatedAt,
  aggregateAlgorithm: ALGORITHM,
  recordCount: records.length,
  aggregateSha256,
  records,
};

fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const manifestSha256 = sha256(fs.readFileSync(MANIFEST_PATH));
process.stdout.write(`${JSON.stringify({ comparator: ALGORITHM, recordCount: records.length, aggregateSha256, manifestSha256 })}\n`);
