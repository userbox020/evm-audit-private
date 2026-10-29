#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-debt-manager-share-differential";
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-23-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-23-${NAME}-handoff.md`;
const SOL_TEST = "targets/cash-v3/test/critical/DebtManagerShareDonationDifferential.t.sol";
const REVISION = "debt-manager-share-differential-local-exact-source-r1";
const abs = (x) => path.join(ROOT, x);
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");

const rawText = fs.readFileSync(abs(RAW), "utf8");
const raw = JSON.parse(rawText);
const manifestText = fs.readFileSync(abs(MANIFEST), "utf8");
const manifest = JSON.parse(manifestText);
const report = fs.readFileSync(abs(REPORT), "utf8");
const inboxText = fs.readFileSync(abs(INBOX), "utf8");
const inbox = JSON.parse(inboxText);
const handoff = fs.readFileSync(abs(HANDOFF), "utf8");
const sol = fs.readFileSync(abs(SOL_TEST), "utf8");

assert.strictEqual(raw.revision, REVISION);
assert.strictEqual(raw.classification, "WATCH/SOURCE-LEVEL PRIMITIVE CANDIDATE PENDING REVIEW/PERMISSIONLESS-ZERO-SHARE-DONATION/CAPITAL-AND-STATE-PRECONDITIONS-UNBOUND");
assert.deepStrictEqual(raw.pipeline, { stage: 0, totalStages: 5, sourceLevelPrimitiveCandidatePendingReview: true, productionPrimitiveEstablished: false });
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
for (const [k, v] of Object.entries(raw.safety)) {
  if (k === "localOnly") assert.strictEqual(v, true, k);
  else assert.strictEqual(v, false, k);
}
assert.strictEqual(raw.exactSource.commit, "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8");
assert.strictEqual(raw.exactSource.cleanDetachedWorktree, true);
assert.strictEqual(raw.exactSource.dependencyClosureCompiledOffline, true);
assert.strictEqual(raw.exactSource.deploymentEquivalence, false);
for (const [k, v] of Object.entries(raw.exactSource.facts)) assert.strictEqual(v, true, k);
assert.strictEqual(raw.foundry.offline, true);
assert.strictEqual(raw.foundry.build.exitStatus, 0);
assert.strictEqual(raw.foundry.firstRun.exitStatus, 0);
assert.strictEqual(raw.foundry.replayRun.exitStatus, 0);
assert.strictEqual(raw.foundry.fuzzRunsPerFuzzTest, 512);
assert.strictEqual(raw.foundry.semanticReplayEqual, true);
assert.strictEqual(raw.tests.sourceFunctionCount, raw.tests.passedFunctionCount);
assert(raw.tests.deterministicTestCount >= 17);
assert.strictEqual(raw.tests.fuzzTestCount, 4);
assert.strictEqual(raw.tests.fuzzCaseCount, 2048);
assert.strictEqual(raw.tests.totalExecutedCases, raw.tests.deterministicTestCount + 2048);
assert.strictEqual(raw.tests.invariantMatrix.length, 12);
assert(raw.tests.invariantMatrix.every((x) => x.result === "PASS"));
const covered = new Set(raw.tests.passRows.map((x) => x.name));
for (const row of raw.tests.invariantMatrix) for (const test of row.tests) assert(covered.has(test), `${row.id}:${test}`);
assert.strictEqual(raw.formulasAndBounds.exactFormula.minimalDonationForZeroShares, "d_min = s*(v-1)+1 for integer raw units and v>=1");
assert.strictEqual(raw.formulasAndBounds.maximumEnumeratedNet.attackerNet, "1000");
assert.strictEqual(raw.formulasAndBounds.boundedCapitalScenarios.sixDecimalMinSharesTenTokens.attackerNet, "99999");
assert.strictEqual(raw.exactDeltas.minimalDeterministicCase.attackerNet, "7");
assert.strictEqual(raw.exactDeltas.minimalDeterministicCase.victimNet, "-7");
assert.strictEqual(raw.conclusions.sourceBehaviorConfirmsZeroShareMint, true);
assert.strictEqual(raw.conclusions.safeReferenceRejectsSameTransition, true);
assert.strictEqual(raw.conclusions.soleIncumbentCanRealizeExactVictimAmountAtBoundary, true);
assert.strictEqual(raw.conclusions.boundedPositiveCycleExistsWithoutPrivilegedControl, true);
assert.strictEqual(raw.conclusions.practicalCurrentCycleEstablished, false);
assert.strictEqual(raw.conclusions.currentDeploymentAffected, null);
assert.strictEqual(raw.conclusions.productionLossEstablished, false);
assert.strictEqual(raw.conclusions.productionAttackerProfitEstablished, false);
assert(raw.assumptions.length >= 7);
assert(raw.blockers.length >= 5);

assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(manifest.classification, raw.classification);
assert.strictEqual(manifest.pipeline, "0/5");
assert.strictEqual(manifest.localOnly, true);
assert.strictEqual(manifest.noRpcInventoryWebForkLive, true);
assert.strictEqual(manifest.dependencyClosureCompiledOffline, true);
assert.strictEqual(manifest.deploymentEquivalence, false);
assert.strictEqual(manifest.sourceLevelPrimitiveCandidatePendingReview, true);
assert.strictEqual(manifest.productionPrimitiveEstablished, false);
assert.strictEqual(manifest.fuzzCaseCount, 2048);
assert.strictEqual(manifest.semanticReplayEqual, true);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(inbox.pipeline, "0/5");
for (const rec of manifest.records) {
  const data = fs.readFileSync(abs(rec.path));
  assert.strictEqual(data.length, rec.bytes, `bytes ${rec.path}`);
  assert.strictEqual(hash(data), rec.sha256, `hash ${rec.path}`);
}
assert.strictEqual(hash(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")), manifest.aggregateSha256);

assert(sol.includes("contract DebtManagerShareHarness is DebtManagerCore"));
assert(sol.includes("contract SafeShareReference"));
assert(sol.includes("testFuzz_zeroShareBoundaryFormulaAndExactNet"));
assert(sol.includes("test_interestIndexChangesMintDenominatorAndRepayRestoresLiquidity"));
assert(sol.includes("test_transferFromCallbackCannotReenterSupply"));
assert(!/create(?:Select)?Fork|fork-url|rpc_endpoints|graphql_endpoints|eth_call|startBroadcast|vm\.env|https?:\/\//.test(sol));
const leak = [rawText, manifestText, report, inboxText, handoff].join("\n");
assert(!/https?:\/\/[a-z0-9]/i.test(leak), "URL leak");
assert(!/[?&](?:key|token|api_key|apikey)=/i.test(leak), "credential leak");
assert(!/(authorization|cookie|set-cookie)\s*[:=]/i.test(leak), "header leak");
assert(report.includes("🟠 WATCH"));
assert(report.includes("SOURCE-LEVEL PRIMITIVE CANDIDATE PENDING REVIEW"));
assert(report.includes("Pipeline:** `0/5`"));
assert(report.includes("d_min = s*(v-1)+1"));
assert(report.includes("No practical current cycle is established"));
assert(report.includes("nextGate"));
assert(handoff.includes(raw.runId));
process.stdout.write(`PASS EtherFi DebtManager share differential (${raw.runId}; functions=${raw.tests.passedFunctionCount}; fuzz=${raw.tests.fuzzCaseCount}; records=${manifest.records.length}; ${manifest.aggregateSha256})\n`);
