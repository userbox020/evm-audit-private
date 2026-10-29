#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
if (process.argv.length !== 3 || process.argv[2] !== "--check") { console.error("usage: node validate-venus-vtoken-underburn-step2.js --check"); process.exit(2); }
const manifestPath = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-manifest.json");
const capturePath = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-capture.json");
const summaryPath = path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-summary.json");
const reportPath = path.join(ROOT, "reports/critical-venus-vtoken-underburn-step2.md");
let checks = 0; const failures = [];
function check(ok, label) { checks++; if (!ok) failures.push(label); }
function sha(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
let manifest, capture, summary;
try { manifest = JSON.parse(fs.readFileSync(manifestPath)); capture = JSON.parse(fs.readFileSync(capturePath)); summary = JSON.parse(fs.readFileSync(summaryPath)); } catch (e) { console.error(`parse failed: ${e.message}`); process.exit(1); }
check(manifest.schemaVersion === 1, "manifest schema");
check(manifest.findingId === "venus-vtoken-redeem-underburn-step2", "finding id");
check(capture.classification === "INCOMPLETE_COVERAGE_WITH_CURRENT_BOUND_MARKETS_ROUTE_NEGATIVE", "classification");
check(capture.coverage.chainsWithFinalizedPin === 8, "pin coverage");
check(capture.coverage.coreMarketsEnumerated === 52, "core markets");
check(capture.coverage.isolatedPoolsEnumerated === 19, "isolated pools");
check(capture.coverage.isolatedMarketsEnumerated === 114, "isolated markets");
check(summary.coverage.bnbCoreRowsWithCurrentRate > 0 && summary.coverage.bnbCoreRowsWithCurrentRate < 52, "complete BNB rows");
check(capture.coverage.coreMarketsRuntimeAffectedExact === 1, "exact core runtime");
check(capture.coverage.isolatedExactRuntimeMatches === 9, "exact isolated runtime");
check(capture.gates.operationalRoutePositive === 0 && capture.gates.executableNow === 0, "route gates");
check(capture.gates.signedActionJustified === false && capture.gates.fork === false, "execution gates");
check(capture.chains.every(c => /^\d+$/.test(c.pin?.number || "") && /^0x[0-9a-f]{64}$/.test(c.pin?.hash || "")), "canonical pins");
check(capture.chains.every(c => c.coverage.terminal.allMatch === true), "terminal pin rechecks");
check(capture.chains.find(c => c.chainId === 56).coverage.familyAgreement.stateDigestAgreement === false, "BNB disagreement preserved");
check(capture.chains.find(c => c.chainId === 204).coverage.familyAgreement.stateDigestAgreement === null, "opBNB null preserved");
check(Object.values(capture.leakGuard).every(x => x === 0), "capture leak guard");
check(Array.isArray(manifest.artifacts) && manifest.artifacts.length >= 10, "artifact inventory");
for (const a of manifest.artifacts || []) {
  const file = path.join(ROOT, a.path.replaceAll("/", path.sep));
  check(fs.existsSync(file), `exists ${a.path}`);
  if (fs.existsSync(file)) {
    check(sha(file) === a.sha256, `hash ${a.path}`);
    if (a.text !== false) {
      const text = fs.readFileSync(file, "utf8");
      check(!/https?:\/\//i.test(text), `no URL ${a.path}`);
      check(!text.split(/\r?\n/).some(line => /[ \t]+$/.test(line)), `whitespace ${a.path}`);
    }
  }
}
const preimage = manifest.artifacts.map(a => `${a.path}:${a.sha256}`).join("\n");
check(crypto.createHash("sha256").update(preimage).digest("hex") === manifest.aggregateSha256, "aggregate");
const report = fs.readFileSync(reportPath, "utf8");
check(report.includes("INCOMPLETE_COVERAGE_WITH_CURRENT_BOUND_MARKETS_ROUTE_NEGATIVE"), "report classification");
check(report.includes("No backend/operator independence is claimed"), "independence caveat");
check(report.includes("vSXP"), "exact market report");
check(report.includes("largest complete-state scenario"), "top net report");
if (failures.length) { console.error(`FAIL ${checks - failures.length}/${checks}: ${failures.join("; ")}`); process.exit(1); }
console.log(`PASS ${checks}/${checks} checks; check-only; no files written`);
