#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = "reports/raw/fast/critical-derive-v2-cash-pnl-deployment-economics-step2-manifest.json";
const ALGORITHM =
  "sha256(UTF-8 JSON.stringify(records sorted ascending by unsigned ordinal UTF-8 bytes of POSIX path; record key order path,sha256,bytes; no extra whitespace))";
const PATHS = [
  "reports/critical-derive-v2-cash-pnl-deployment-economics-step2.md",
  "reports/raw/fast/critical-derive-v2-cash-pnl-deployment-economics-step2-tests.txt",
  "reports/raw/fast/critical-derive-v2-cash-pnl-deployment-economics-step2.json",
  "tools/generate-critical-derive-v2-step2-manifest.js",
  "tools/run-critical-derive-v2-step2.js",
  "tools/test-critical-derive-v2-step2.js",
  "tools/validate-critical-derive-v2-step2.js",
];

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function comparePath(a, b) {
  return Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));
}

function portable(recordPath) {
  return typeof recordPath === "string" && recordPath.length > 0 && !recordPath.includes("\\")
    && !path.posix.isAbsolute(recordPath) && path.posix.normalize(recordPath) === recordPath && !recordPath.startsWith("../");
}

function genericLeakGuard(recordPath, bytes) {
  const text = bytes.toString("utf8");
  if (/https?:\/\/|wss?:\/\//i.test(text)) throw new Error(`URL leak guard: ${recordPath}`);
  if (/\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/i.test(text)) {
    throw new Error(`credential leak guard: ${recordPath}`);
  }
}

const seen = new Set();
const records = PATHS.map((recordPath) => {
  if (!portable(recordPath) || seen.has(recordPath)) throw new Error("invalid manifest path");
  seen.add(recordPath);
  const bytes = fs.readFileSync(path.join(ROOT, ...recordPath.split("/")));
  genericLeakGuard(recordPath, bytes);
  return { path: recordPath, sha256: sha256(bytes), bytes: bytes.length };
}).sort(comparePath);
const aggregateSha256 = sha256(Buffer.from(JSON.stringify(records), "utf8"));
const capture = JSON.parse(fs.readFileSync(path.join(ROOT, "reports/raw/fast/critical-derive-v2-cash-pnl-deployment-economics-step2.json"), "utf8"));
const manifest = {
  schemaVersion: 1,
  generatedAt: capture.generatedAt,
  sourceCommit: capture.predecessor.sourceCommit,
  aggregateAlgorithm: ALGORITHM,
  pathComparator: "ascending unsigned ordinal comparison of UTF-8 encoded normalized relative POSIX path bytes using Node.js Buffer.compare",
  recordCount: records.length,
  aggregateSha256,
  records,
  authorizationProvenance: capture.authorizationProvenance,
  captureSafety: capture.captureSafety,
  offlineR2: capture.offlineR2,
};
const manifestPath = path.join(ROOT, ...MANIFEST.split("/"));
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const manifestSha256 = sha256(fs.readFileSync(manifestPath));
process.stdout.write(`${JSON.stringify({ comparator: ALGORITHM, recordCount: records.length, aggregateSha256, manifestSha256 })}\n`);
