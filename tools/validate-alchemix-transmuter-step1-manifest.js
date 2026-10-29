#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(
  root,
  "reports",
  "raw",
  "fast",
  "critical-alchemix-transmuter-v2-claim-conservation-step1-manifest.json"
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const mismatches = [];

for (const record of manifest.records) {
  const absolute = path.join(root, ...record.path.split("/"));
  if (!fs.existsSync(absolute)) {
    mismatches.push({ path: record.path, issue: "missing" });
    continue;
  }
  const actual = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
  if (actual !== record.sha256) mismatches.push({ path: record.path, issue: "hash", expected: record.sha256, actual });
}

const aggregatePreimage = [...manifest.records]
  .sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))
  .map((record) => `${record.path}\0${record.sha256}\n`)
  .join("");
const aggregate = crypto.createHash("sha256").update(aggregatePreimage, "utf8").digest("hex");
const result = {
  manifest: path.relative(root, manifestPath).split(path.sep).join("/"),
  records: manifest.records.length,
  mismatches,
  aggregate,
  expectedAggregate: manifest.aggregateSha256,
  aggregateMatch: aggregate === manifest.aggregateSha256,
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (mismatches.length !== 0 || !result.aggregateMatch) process.exit(1);
