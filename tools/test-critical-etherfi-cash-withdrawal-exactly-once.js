#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-cash-withdrawal-exactly-once";
const RAW = `reports/raw/fast/${NAME}.json`;
const CLOSURE = `reports/raw/fast/${NAME}-source-closure.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const CLASSIFICATION = "INFORMATIONAL/CONDITIONAL-NONSTANDARD-ERC20-WITHDRAWAL-CONSUMPTION/NO-ATTACKER-CAPTURE/PERMISSIONLESS-FULFILLMENT/EXACT-SOURCE";
const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const check = (ok, message) => { if (!ok) throw new Error(message); };
const hashFile = (rel) => { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; };

const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
const closure = JSON.parse(fs.readFileSync(abs(CLOSURE), "utf8"));
const manifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
check(raw.classification === CLASSIFICATION, "classification drift");
check(raw.selection.permissionlessEntrypoint === "CashModuleCore.processWithdrawal(address)" && raw.selection.exactSourceVerified, "selection drift");
check(raw.source.commitMatch && raw.source.commit === raw.source.expectedCommit && raw.source.cleanCommitBuild.exitStatus === 0, "source/build binding failed");
check(closure.complete && closure.productionSourceDiffAgainstCommit.length === 0 && closure.files.length > 30, "source closure incomplete");
for (const row of closure.files) { const current = hashFile(row.path); check(current.bytes === row.bytes && current.sha256 === row.sha256, `closure drift: ${row.path}`); }
check(raw.tests.passCount === 28 && raw.tests.failCount === 0 && raw.tests.testCount === 28, "test count drift");
check(raw.tests.unitTestCount === 25 && raw.tests.fuzzPropertyCount === 3 && raw.tests.totalFuzzCases >= 768 && raw.tests.deterministicSemanticReplay, "fuzz/replay drift");
check(raw.invariantAssessment.standardTokenExactlyOncePass && raw.invariantAssessment.failuresRetriesAtomicPass && raw.invariantAssessment.reentrancyPass, "standard invariant drift");
check(!raw.invariantAssessment.strictPartialFulfillmentPass && !raw.invariantAssessment.permissionlessAttackerCaptureFound, "conditional finding drift");
check(raw.deltas.returnFalse.requestedRaw === "28000000" && raw.deltas.returnFalse.deliveredRaw === "0" && raw.deltas.returnFalse.attackerGainRaw === "0" && raw.deltas.returnFalse.sourceRequestConsumed, "false-return delta drift");
check(raw.deltas.partialTrue.requestedRaw === "30000000" && raw.deltas.partialTrue.deliveredRaw === "15000000" && raw.deltas.partialTrue.attackerGainRaw === "0" && raw.deltas.partialTrue.sourceRequestConsumed, "partial-return delta drift");
check(raw.conclusion.branchPipeline === "1/5_SOURCE_SEMANTIC_PRIMITIVE_CONDITIONAL_NO_ATTACKER_VALUE" && raw.conclusion.extractionPipeline === "0/5_NO_ATTACKER_VALUE_PATH", "pipeline drift");
check(raw.conclusion.globalHighestPipeline === "DebtManager donation 2/5 WATCH unchanged" && raw.conclusion.routePositive === 0 && raw.conclusion.executableNow === 0 && !raw.conclusion.signedActionJustified, "global gate drift");
check(raw.safety.localOnly && !raw.safety.network && !raw.safety.rpcInventoryRead && !raw.safety.fork && !raw.safety.signedActions && !raw.safety.broadcasts, "safety drift");
check(raw.customHarness.binding === "local-byte-hash-bound" && !raw.customHarness.claimedAsCommitArtifact && raw.source.productionSourceBinding === "commit-bound", "binding class drift");
check(raw.semantics.passed === 10 && Object.values(raw.semantics.checks).every(Boolean), "semantic check drift");
check(!/https?:\/\//i.test(JSON.stringify(raw)) && !/https?:\/\//i.test(JSON.stringify(manifest)), "URL leak");
const currentRecords = manifest.records.map((row) => { const current = hashFile(row.path); check(current.bytes === row.bytes && current.sha256 === row.sha256, `manifest drift: ${row.path}`); return current; });
const aggregate = sha(currentRecords.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
check(aggregate === manifest.aggregateSha256 && manifest.runId === raw.runId, "manifest identity/aggregate drift");
console.log(JSON.stringify({ ok: true, validations: 18, runId: raw.runId, classification: raw.classification, selectedSurface: raw.selection.permissionlessEntrypoint, tests: raw.tests.passCount, fuzzCases: raw.tests.totalFuzzCases, branchPipeline: raw.conclusion.branchPipeline, extractionPipeline: raw.conclusion.extractionPipeline, globalHighestPipeline: raw.conclusion.globalHighestPipeline, manifestAggregateSha256: aggregate }, null, 2));
