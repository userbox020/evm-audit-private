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
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function compareRecords(a, b) {
  return Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));
}

const manifestBytes = fs.readFileSync(MANIFEST_PATH);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.aggregateAlgorithm !== ALGORITHM) fail("aggregate algorithm mismatch");
if (!Array.isArray(manifest.records) || manifest.records.length !== 39 || manifest.recordCount !== 39) {
  fail("record count must be exactly 39");
}

const canonicalRecords = [];
const seen = new Set();
for (const record of manifest.records) {
  if (typeof record.path !== "string" || record.path.length === 0 || record.path.includes("\\")) {
    fail(`invalid POSIX path: ${record.path}`);
  }
  if (path.posix.isAbsolute(record.path) || path.posix.normalize(record.path) !== record.path || record.path.startsWith("../")) {
    fail(`non-normalized relative POSIX path: ${record.path}`);
  }
  if (seen.has(record.path)) fail(`duplicate record path: ${record.path}`);
  seen.add(record.path);
  if (Object.keys(record).join(",") !== "path,sha256,bytes") fail(`record key order mismatch: ${record.path}`);
  const bytes = fs.readFileSync(path.join(ROOT, ...record.path.split("/")));
  if (bytes.length !== record.bytes) fail(`byte count mismatch: ${record.path}`);
  if (sha256(bytes) !== record.sha256) fail(`SHA-256 mismatch: ${record.path}`);
  canonicalRecords.push({ path: record.path, sha256: record.sha256, bytes: record.bytes });
}

const sorted = [...canonicalRecords].sort(compareRecords);
if (JSON.stringify(canonicalRecords) !== JSON.stringify(sorted)) fail("records are not in unsigned ordinal UTF-8 path order");
const aggregateSha256 = sha256(Buffer.from(JSON.stringify(sorted), "utf8"));
if (aggregateSha256 !== manifest.aggregateSha256) fail("aggregate SHA-256 mismatch");

process.stdout.write(`${JSON.stringify({ ok: true, comparator: ALGORITHM, recordCount: 39, aggregateSha256, manifestSha256: sha256(manifestBytes) })}\n`);
