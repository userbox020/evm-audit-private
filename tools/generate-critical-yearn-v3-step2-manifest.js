#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_REL = "reports/raw/fast/critical-yearn-v3-tokenized-strategy-accounting-step2-manifest.json";
const FILES = [
  "reports/raw/fast/critical-yearn-v3-tokenized-strategy-accounting-step2.json",
  "reports/critical-yearn-v3-tokenized-strategy-accounting-step2.md",
  "coordination/inbox/critical/yearn-v3-tokenized-strategy-accounting-step2.json",
  "coordination/handoffs/2026-07-27-critical-yearn-v3-step2.md",
  "tools/run-critical-yearn-v3-step2.js",
  "tools/test-critical-yearn-v3-step2.js",
  "tools/validate-critical-yearn-v3-step2.js",
  "tools/generate-critical-yearn-v3-step2-manifest.js"
];
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`; return JSON.stringify(value); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel)); }
function generate() {
  const raw = JSON.parse(read(FILES[0])), files = FILES.map(rel => ({ path: rel, bytes: read(rel).length, sha256: sha(read(rel)) }));
  const manifest = { schemaVersion: 2, findingId: "critical-yearn-v3-tokenized-strategy-accounting-step2", runId: raw.runId, classification: raw.classification, generatedAt: new Date().toISOString(), generator: "tools/generate-critical-yearn-v3-step2-manifest.js", validatorMode: "check-only", files };
  manifest.aggregateSha256 = sha(canonical(files.map(x => ({ path: x.path, bytes: x.bytes, sha256: x.sha256 }))));
  fs.writeFileSync(path.join(ROOT, MANIFEST_REL), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestSha256: sha(fs.readFileSync(path.join(ROOT, MANIFEST_REL))) };
}
if (require.main === module) { const out = generate(); process.stdout.write(`${JSON.stringify({ status: "GENERATED", files: out.manifest.files.length, aggregateSha256: out.manifest.aggregateSha256, manifestSha256: out.manifestSha256 })}\n`); }
module.exports = { ROOT, FILES, MANIFEST_REL, sha, canonical, generate };
