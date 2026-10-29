#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-cashback-exactly-once";
const RAW = `reports/raw/fast/${NAME}.json`;
const CLOSURE = `reports/raw/fast/${NAME}-source-closure.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const CLASSIFICATION = "INFORMATIONAL/PENDING_REVIEW/PRIVILEGED-WALLET-UNBOUND-CASHBACK-INPUT/DUPLICATE-PAYOUT-AND-RECIPIENT-REDIRECT/NO-PERMISSIONLESS-TRIGGER/EXACT-SOURCE";
const abs = (rel) => path.join(ROOT, rel);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const check = (ok, message) => { if (!ok) throw new Error(message); };
const hashFile = (rel) => { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; };

const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
const closure = JSON.parse(fs.readFileSync(abs(CLOSURE), "utf8"));
const manifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
check(raw.classification === CLASSIFICATION, "classification drift");
check(raw.source.commitMatch && raw.source.commit === raw.source.expectedCommit && raw.source.cleanCommitBuild.exitStatus === 0, "source/build binding failed");
check(closure.complete && closure.productionSourceDiffAgainstCommit.length === 0 && closure.files.length > 20, "source closure incomplete");
for (const row of closure.files) { const current = hashFile(row.path); check(current.bytes === row.bytes && current.sha256 === row.sha256, `closure drift: ${row.path}`); }
check(raw.tests.passCount === 24 && raw.tests.failCount === 0 && raw.tests.testCount === 24, "test count drift");
check(raw.tests.unitTestCount === 21 && raw.tests.fuzzPropertyCount === 3 && raw.tests.totalFuzzCases >= 768 && raw.tests.deterministicSemanticReplay, "fuzz/replay drift");
check(raw.deltas.fixedDuplicate.sourceRecipientPayoutRaw === "6000000" && raw.deltas.fixedDuplicate.referenceRecipientPayoutRaw === "3000000" && raw.deltas.fixedDuplicate.excessPayoutRaw === "3000000", "duplicate delta drift");
check(raw.deltas.privilegedRedirect.attackerPayoutTokenRaw === "1000000000" && raw.deltas.privilegedRedirect.sourceCap === null, "redirect/cap delta drift");
check(raw.deltas.crossInstanceSameId.excessPayoutRaw === "17000000", "cross-instance delta drift");
check(raw.deltas.retries.duplicatePayoutRaw === "0" && raw.deltas.retries.finalPendingUsdRaw === "0" && raw.deltas.retries.callerPayoutRaw === "0", "retry invariant drift");
check(raw.invariantAssessment.overallPass === false && raw.invariantAssessment.retryAndCallbackExactlyOncePass === true && raw.invariantAssessment.permissionlessTriggerFound === false, "invariant assessment drift");
check(raw.conclusion.branchPipeline === "1/5_SOURCE_PRIMITIVE_PENDING_REVIEW" && raw.conclusion.routePositive === 0 && raw.conclusion.executableNow === 0 && !raw.conclusion.signedActionJustified, "pipeline/gate drift");
check(raw.safety.localOnly && !raw.safety.network && !raw.safety.rpcInventoryRead && !raw.safety.fork && !raw.safety.signedActions, "safety drift");
check(raw.customHarness.binding === "local-byte-hash-bound" && !raw.customHarness.claimedAsCommitArtifact && raw.source.productionSourceBinding === "commit-bound", "binding class drift");
check(!/https?:\/\//i.test(JSON.stringify(raw)) && !/https?:\/\//i.test(JSON.stringify(manifest)), "URL leak");
const recomputed = manifest.records.map((row) => { const current = hashFile(row.path); check(current.bytes === row.bytes && current.sha256 === row.sha256, `manifest drift: ${row.path}`); return current; });
const aggregate = sha(recomputed.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
check(aggregate === manifest.aggregateSha256 && manifest.runId === raw.runId, "manifest identity/aggregate drift");
console.log(JSON.stringify({ ok: true, validations: 17, runId: raw.runId, classification: raw.classification, tests: raw.tests.passCount, fuzzCases: raw.tests.totalFuzzCases, branchPipeline: raw.conclusion.branchPipeline, manifestAggregateSha256: aggregate }, null, 2));
