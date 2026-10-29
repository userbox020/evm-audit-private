#!/usr/bin/env node
"use strict";

// Offline validator. It never reads endpoint inventories and never performs network I/O.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-ccip-syrupusdt-global-backing-refresh-r2";
const RAW = `reports/raw/fast/${NAME}.json`, EVIDENCE = `reports/raw/fast/${NAME}-evidence.json`, TESTS = `reports/raw/fast/${NAME}-tests.json`, LEAK = `reports/raw/fast/${NAME}-leak-scan.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`;
const PRE = "876ac78d95faffd94c8e9d8cf740fa6cd8f5930db3d6d6babb80fc1a8cf319ef", AUTH = "82c4a08e3f8e27bf29836191f46e7f57513bd9b9d331cae1fd13b94bb964f88d";
const abs = (x) => path.join(ROOT, ...x.split("/")); const sha = (x) => crypto.createHash("sha256").update(x).digest("hex"); const json = (x) => JSON.parse(fs.readFileSync(abs(x), "utf8")); const rec = (x) => { const b = fs.readFileSync(abs(x)); return { bytes: b.length, sha256: sha(b) }; }; const assert = (x, m) => { if (!x) throw new Error(m); };
function main() {
  const raw = json(RAW), evidence = json(EVIDENCE), tests = json(TESTS), leak = json(LEAK), manifest = json(MANIFEST), report = fs.readFileSync(abs(REPORT), "utf8"); let checks = 0; const ok = (x, m) => { assert(x, m); checks++; };
  for (const row of manifest.records) { const a = rec(row.path); ok(a.bytes === row.bytes && a.sha256 === row.sha256, `record:${row.path}`); }
  ok(sha(Buffer.from(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"))) === manifest.aggregateSha256, "aggregate");
  ok(raw.predecessors.globalBacking.aggregateSha256 === PRE && raw.predecessors.lockReleaseAuthorization.aggregateSha256 === AUTH, "predecessors");
  ok(raw.routes.length === 4 && Object.keys(raw.pins.chains).length === 5, "scope");
  ok(raw.pins.spreadSeconds <= raw.pins.toleranceSeconds && raw.pins.toleranceSeconds === 30, "timestamp-tolerance");
  ok(Object.values(raw.pins.chains).every((x) => x.terminalRecheck === true && x.selectedFamilyCount >= 1), "pins-terminal");
  ok(raw.conservation.remoteRows.length === 4 && raw.conservation.feesExcluded === true, "equation-inputs");
  ok(evidence.runId === raw.runId && evidence.conservation.equation === raw.conservation.equation, "evidence-binding");
  ok(raw.conservation.modelComplete || [raw.conservation.deltaRaw, raw.conservation.deficitRaw, raw.conservation.surplusRaw].every((x) => x === null), "tristate");
  if (raw.conservation.modelComplete) { const c = BigInt(raw.conservation.ethereumCustodyRaw), l = BigInt(raw.conservation.attributableLiabilityRaw), d = BigInt(raw.conservation.deltaRaw); ok(c - l === d, "bigint-equation"); }
  ok(raw.gates.routePositive === 0 && raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false && raw.gates.fork === false, "gates");
  ok(tests.status === "PASS" && tests.passed === tests.total, "tests"); ok(leak.status === "PASS" && leak.endpointIdentitiesPersisted === false && leak.rawResponsesPersisted === false, "leak");
  ok(!/(?:https?|wss?):\/\//i.test([JSON.stringify(raw), JSON.stringify(evidence), JSON.stringify(tests), JSON.stringify(leak), report].join("\n")), "no-url");
  ok(report.includes(`Signal: 🟠 **${raw.classification}**`) && report.includes("Missing or unattributable routes are never treated as zero"), "report");
  process.stdout.write(`${JSON.stringify({ status: "PASS", offline: true, checks, runId: raw.runId, classification: raw.classification, pins: Object.keys(raw.pins.chains).length, routes: raw.routes.length, modelComplete: raw.conservation.modelComplete, gates: raw.gates, aggregateSha256: manifest.aggregateSha256 })}\n`);
}
try { main(); } catch (error) { process.stderr.write(`validator failed:${error.message}\n`); process.exitCode = 1; }
