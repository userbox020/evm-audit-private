#!/usr/bin/env node
"use strict";

// Strictly offline packaging validator. It performs hash and semantic checks only.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-cashmodule-source-runtime-continuity-r4";
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/review-${NAME}-2026-07-24.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const SCANNER = `tools/scan-${NAME}.js`;
const R3_RAW = "reports/raw/fast/critical-etherfi-cashmodule-source-runtime-continuity-r3.json";
const R3_MANIFEST = "reports/raw/fast/critical-etherfi-cashmodule-source-runtime-continuity-r3-manifest.json";
const EXPECTED_R3_AGGREGATE = "ddd58f3aad994a4c48efb832e47a1ac94e603e221ded4903cd0a606653399cfa";
const CORE_RUNTIME = "0xd5a9fdc7bfbe6b1aad67f89ca343b7c0d7ef4e5be009f1f839e318c190676a96";
const SETTERS_RUNTIME = "0x7879eb1ff3bc862e351f9628fadb509b009545826e32d3415f79ddd12e51c4b5";
const EXPECTED_CLASSIFICATION = "INFORMATIONAL/CLOSED-CURRENT-PIN/REVIEWER-R4/OFFLINE-PACKAGING-CORRECTION/R3-EXACT-RUNTIME-CONCLUSIONS-UNCHANGED/TWO-R3-PUBLIC-SOURCE-VERIFICATION-HTTP-READS/ZERO-RPC-FORK-LIVE/NO-ATTACKER-GAIN";
const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
let checks = 0;
function check(value, message) { if (!value) throw new Error(message); checks++; }
function verifyRecords(manifest) {
  for (const row of manifest.records) {
    const data = fs.readFileSync(abs(row.path));
    check(data.length === row.bytes && sha(data) === row.sha256, `manifest record mismatch: ${row.path}`);
  }
  return sha(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"));
}

const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
const manifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
const r3 = JSON.parse(fs.readFileSync(abs(R3_RAW), "utf8"));
const r3Manifest = JSON.parse(fs.readFileSync(abs(R3_MANIFEST), "utf8"));
const inbox = JSON.parse(fs.readFileSync(abs(INBOX), "utf8"));

check(raw.classification === EXPECTED_CLASSIFICATION, "classification mismatch");
check(raw.correctionScope.packagingOnly === true && raw.correctionScope.technicalConclusionChanged === false && raw.correctionScope.runtimeHashesChanged === false && raw.correctionScope.fixedPinChanged === false, "packaging scope mismatch");
check(r3.safety.publicSourceVerificationReads === 2, "R3 publicSourceVerificationReads must equal 2");
check(raw.activityScope.r3Historical.publicSourceVerificationReads === 2, "R4 historical publicSourceVerificationReads must equal 2");
check(raw.activityScope.r4PackagingRun.publicSourceVerificationReads === 0 && raw.activityScope.r4PackagingRun.otherHttpReads === 0, "R4 HTTP read scope mismatch");
for (const scope of [raw.activityScope.r3Historical, raw.activityScope.r4PackagingRun]) {
  check(scope.rpcInventoryReads === 0 && scope.rpcCalls === 0 && scope.forkExecutions === 0 && scope.transactions === 0 && scope.signedActions === 0 && scope.broadcasts === 0 && scope.productionMutations === 0, "scoped RPC/fork/live activity mismatch");
}
check(raw.activityScope.r4PackagingRun.offlinePackagingOnly === true && raw.activityScope.r4PackagingRun.compilationRuns === 0, "R4 offline packaging gate mismatch");
check(inbox.activityScope.historicalR3PublicSourceVerificationReads === 2 && inbox.activityScope.r4PublicSourceVerificationReads === 0 && inbox.activityScope.r4OtherHttpReads === 0, "inbox activity scope mismatch");

const r3Aggregate = verifyRecords(r3Manifest);
check(r3Aggregate === r3Manifest.aggregateSha256 && r3Aggregate === EXPECTED_R3_AGGREGATE, "R3 aggregate mismatch");
check(raw.predecessorR3.manifest.aggregateSha256 === EXPECTED_R3_AGGREGATE, "R3 manifest projection mismatch");
check(raw.predecessorR3.manifest.recordCount === r3Manifest.records.length, "R3 record count mismatch");
check(canonical(raw.predecessorR3.records) === canonical(r3Manifest.records), "R3 records not preserved");

const expectedTechnical = { correction: r3.correction, fixedPin: r3.fixedPin, components: r3.components, binding: r3.binding, currentConfigurationGate: r3.currentConfigurationGate, conclusion: r3.conclusion, localBuild: r3.localBuild, evidenceCommitmentSha256: r3.evidenceCommitmentSha256, nextGate: r3.nextGate };
check(canonical(raw.retainedTechnicalEvidence) === canonical(expectedTechnical), "R3 technical evidence changed");
check(raw.retainedTechnicalEvidenceSha256 === sha(canonical(expectedTechnical)), "retained technical digest mismatch");
check(raw.retainedTechnicalEvidence.evidenceCommitmentSha256 === r3.evidenceCommitmentSha256, "R3 evidence commitment changed");
check(raw.retainedTechnicalEvidence.conclusion.status === r3.conclusion.status && raw.retainedTechnicalEvidence.conclusion.branchPipeline === r3.conclusion.branchPipeline && raw.retainedTechnicalEvidence.conclusion.extractionPipeline === r3.conclusion.extractionPipeline, "R3 conclusion changed");
check(raw.r4Conclusion.coreRuntimeKeccak256 === CORE_RUNTIME && raw.r4Conclusion.settersRuntimeKeccak256 === SETTERS_RUNTIME, "runtime hashes changed");
check(raw.r4Conclusion.exactSourceRuntimeContinuity === true && raw.r4Conclusion.currentPinClosure === true, "exact/current-pin conclusion changed");
check(raw.r4Conclusion.routePositive === 0 && raw.r4Conclusion.executableNow === 0 && raw.r4Conclusion.signedActionJustified === false && raw.r4Conclusion.attackerGainRaw === "0", "route/value gate changed");

const scannerText = fs.readFileSync(abs(SCANNER), "utf8");
check(!/\bfetch\s*\(/.test(scannerText) && !/https?:\/\//i.test(scannerText) && !/require\(["'](?:http|https|net|tls|dns)["']\)/.test(scannerText), "R4 scanner contains external-call capability");
const generatedTexts = [RAW, REPORT, INBOX, HANDOFF].map((rel) => fs.readFileSync(abs(rel), "utf8"));
const contradictory = /\bno[- ]network\b|\bzero[- ]network\b|\bwithout (?:any )?network\b|["']network["']\s*:\s*false|["']networkCalls["']\s*:\s*0/i;
for (const [index, text] of generatedTexts.entries()) check(!contradictory.test(text), `contradictory broad network claim in generated artifact ${index}`);
check(generatedTexts[1].includes("exactly **2 public source-verification HTTP reads**"), "report omits R3 HTTP read count");
check(generatedTexts[3].includes("exactly 2 public source-verification HTTP reads"), "handoff omits R3 HTTP read count");

const aggregate = verifyRecords(manifest);
check(aggregate === manifest.aggregateSha256, "R4 manifest aggregate mismatch");

console.log(JSON.stringify({ ok: true, checks, runId: raw.runId, classification: raw.classification, r3PublicSourceVerificationReads: raw.activityScope.r3Historical.publicSourceVerificationReads, r4PublicSourceVerificationReads: raw.activityScope.r4PackagingRun.publicSourceVerificationReads, r4OtherHttpReads: raw.activityScope.r4PackagingRun.otherHttpReads, coreRuntime: raw.r4Conclusion.coreRuntimeKeccak256, settersRuntime: raw.r4Conclusion.settersRuntimeKeccak256, r3ManifestAggregateSha256: EXPECTED_R3_AGGREGATE, manifestAggregateSha256: manifest.aggregateSha256 }, null, 2));
