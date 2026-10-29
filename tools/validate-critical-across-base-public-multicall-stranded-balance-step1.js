#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { runTests } = require("./test-critical-across-base-public-multicall-stranded-balance-step1.js");

const ROOT = path.resolve(__dirname, ".."), NAME = "critical-across-base-public-multicall-stranded-balance-step1";
const RAW = `reports/raw/fast/${NAME}.json`, HISTORY = `reports/raw/fast/${NAME}-history.json`, TESTS = `reports/raw/fast/${NAME}-tests.json`, LEAK = `reports/raw/fast/${NAME}-leak-scan.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`, INBOX = `coordination/inbox/critical/2026-07-25-${NAME}.json`, HANDOFF = `coordination/handoffs/2026-07-25-${NAME}-handoff.md`;
const SCANNER = `tools/scan-${NAME}.js`, TESTER = `tools/test-${NAME}.js`, VALIDATOR = `tools/validate-${NAME}.js`;
const abs = (rel) => path.join(ROOT, rel), read = (rel) => fs.readFileSync(abs(rel)), json = (rel) => JSON.parse(read(rel).toString("utf8")), sha = (value) => crypto.createHash("sha256").update(value).digest("hex"), hashFile = (rel) => { const body = read(rel); return { path: rel, bytes: body.length, sha256: sha(body) }; }, aggregate = (records) => sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));

function main() {
  const checks = []; function check(value, label) { checks.push(label); assert(value, label); }
  for (const rel of [RAW, HISTORY, TESTS, LEAK, MANIFEST, REPORT, INBOX, HANDOFF, SCANNER, TESTER, VALIDATOR]) check(fs.existsSync(abs(rel)), `exists:${rel}`);
  const raw = json(RAW), history = json(HISTORY), tests = json(TESTS), leak = json(LEAK), manifest = json(MANIFEST), inbox = json(INBOX), report = read(REPORT).toString("utf8");
  check(raw.classification === "DORMANT/PERMISSIONLESS-FULL-BALANCE-SWEEP/CONFIGURED-CANONICAL-BALANCES-ZERO/NONCONFIGURED-UNPRICED-BALANCES/NO-MATERIAL-VALUE-ESTABLISHED/EXACT-PUBLIC-HANDLER-RUNTIME", "classification");
  check(raw.pipeline.stage === 1 && raw.pipeline.total === 5 && raw.pipeline.sourcePrimitive && raw.pipeline.exactPublicRuntime && !raw.pipeline.currentMaterialBalance && !raw.pipeline.forkProof && !raw.pipeline.economics, "pipeline");
  check(raw.gates.routePositive === 0 && raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false && raw.gates.fork === false, "gates");
  check(history.fixedFinalizedPin.number === raw.endpointCoverage.fixedFinalizedPin.number && history.fixedFinalizedPin.hash === raw.endpointCoverage.fixedFinalizedPin.hash && history.fixedFinalizedPin.terminalRecheck === true, "pin-terminal");
  check(history.fixedFinalizedPin.selectedFamilyCount === 2 && raw.endpointCoverage.selectedArchiveLogFamilies === 2 && raw.endpointCoverage.archiveLogQualifiedFamilies >= 2, "two-families");
  check(history.tokenTransferHistory.crossFamilyAgreement === true && history.tokenTransferHistory.familyCount === 2 && history.tokenTransferHistory.familyCommitments.length === 2 && new Set(history.tokenTransferHistory.familyCommitments.map((row) => row.commitment)).size === 1, "history-cross-family");
  check(history.tokenTransferHistory.exactCommitment === raw.history.exactTransferCommitment && history.tokenTransferHistory.rows === raw.history.rows, "history-binding");
  check(history.tokenTransferHistory.coverage.includes("COMPLETE_FOR_TRANSFER-SIGNATURE") && raw.history.standardTransferHistoryCrossFamilyComplete === true, "standard-transfer-complete");
  check(history.nativeHistory.completeDeploymentToPinTraceEnumeration === false && raw.history.nativeHistoryComplete === false && history.nativeHistory.status === "COVERAGE_GAPPED", "native-history-caveat");
  check(raw.currentCustody.nativeBalanceWei === "0" && raw.currentCustody.materialCurrentBalance === false && raw.currentCustody.currentKnownUsdValue === 0 && raw.currentCustody.totalUsdValue === null, "no-material-current-custody");
  check(raw.currentCustody.tokenStates.length >= 1 && raw.currentCustody.materialStates.length >= 1 && raw.currentCustody.materialStates.every((row) => row.balanceRaw === "0" && row.familyAgreement), "material-token-zero-agreement");
  check(raw.currentCustody.nonconfiguredNonzeroCount > 0 && /^[0-9a-f]{64}$/.test(raw.currentCustody.nonconfiguredNonzeroCommitment), "unpriced-nonconfigured-caveat");
  check(raw.binding.publicHandler.exactRuntimeEquivalence === true && raw.binding.publicHandler.standardProxySlotsZero === true && raw.binding.publicHandler.proxy === false, "public-runtime-direct");
  check(raw.binding.permissionedHandler.codePresent && raw.binding.permissionedHandler.familyAgreement && raw.binding.sponsoredPeriphery.codePresent && raw.binding.sponsoredPeriphery.familyAgreement, "aux-code");
  check(raw.binding.permissionedHandler.exactSourceRuntimeEquivalence === null && raw.binding.sponsoredPeriphery.exactSourceRuntimeEquivalence === null && raw.binding.permissionedHandler.buildClosureStatus === "LOCAL-EXACT-BUILD-UNAVAILABLE", "aux-build-gap");
  check(raw.source.publicHandler.permissionless && raw.source.publicHandler.amountAndRelayerIgnored && raw.source.publicHandler.emptyInstructionsAllowed && raw.source.publicHandler.drainReadsEntireCurrentBalance && raw.source.publicHandler.callerControlsFallbackRecipient, "source-primitive");
  check(raw.reachability.publicHandlerPermissionlessBySource && raw.reachability.liveExploitCallExecuted === false && raw.reachability.permissionedHandlerRejectsArbitraryAttacker && raw.reachability.sponsoredPeripheryUsesPermissionedHandler, "reachability-linkage");
  check(raw.source.sponsoredPeriphery.immutableMulticallHandler === "0xb6caafd8ecf18385ffc7c020327e111a1d40a2d4" && raw.source.sponsoredPeriphery.linkageExact, "permissioned-linkage");
  check(raw.arbitraryExecutorDustCloseout.dustRecipientHardcodedToAddressThis && raw.arbitraryExecutorDustCloseout.dustDrainedBeforeSnapshots && raw.arbitraryExecutorDustCloseout.positiveDeltaAccounting && raw.arbitraryExecutorDustCloseout.publicDustPremiseClosedForExecutor, "executor-closeout");
  check(raw.fork.created === false && (raw.fork.reason.includes("no established") || raw.fork.reason.includes("configured/canonical")), "no-fork-gate");
  check(tests.passed && tests.deterministicCases === 4 && tests.fuzzCases === 512 && tests.fuzzPassed === 512 && tests.liveCallExecuted === false && tests.forkCreated === false, "tests");
  const rerun = runTests(); check(JSON.stringify(rerun) === JSON.stringify(tests), "tests-reproducible");
  check(tests.solidityRegression.buildAttempted && !tests.solidityRegression.buildPassed && tests.solidityRegression.semanticCasesMirroredInJs, "solidity-build-blocker");
  check(history.graphqlPrefilter.usedForCompleteness === false && history.graphqlPrefilter.usedForFinality === false, "graphql-prefilter-only");
  check(raw.activityScope.liveSignedTransactions === 0 && raw.activityScope.broadcasts === 0 && raw.activityScope.productionMutation === false && raw.activityScope.realFundsUsed === false && raw.activityScope.keyFilesRead === 0 && raw.activityScope.forkCreated === false && raw.activityScope.endpointMaterialPersisted === false && raw.activityScope.rawResponsesPersisted === false, "activity-safety");
  check(leak.passed && leak.findingCount === 0 && leak.endpointUrlsDomainsHeadersKeysPersisted === false && leak.rawRpcGraphqlResponsesPersisted === false, "leak");
  check(!/(?:https?|wss?):\/\//i.test(read(RAW).toString("utf8") + read(HISTORY).toString("utf8") + report), "no-url-artifacts");
  const records = manifest.records.map((record) => { const actual = hashFile(record.path); check(actual.bytes === record.bytes && actual.sha256 === record.sha256, `record:${record.path}`); return actual; });
  check(aggregate(records) === manifest.aggregateSha256, "manifest-aggregate");
  check(manifest.runId === raw.runId && inbox.runId === raw.runId && manifest.fixedFinalizedPin.hash === history.fixedFinalizedPin.hash, "run-continuity");
  check(manifest.historyBinding.exactTransferSignatureCommitment === history.tokenTransferHistory.exactCommitment && manifest.historyBinding.artifact.sha256 === hashFile(HISTORY).sha256, "manifest-history");
  check(manifest.currentCustody.materialCurrentBalance === false && manifest.currentCustody.totalUsdValue === null && manifest.tests.passed && manifest.leakScan.sha256 === hashFile(LEAK).sha256, "manifest-evidence");
  check(report.includes("DORMANT") && report.includes("Pipeline") && (report.includes("COVERAGE") || report.includes("coverage-gapped")), "report");
  check(inbox.routePositive === 0 && inbox.executableNow === 0 && inbox.signedActionJustified === false && inbox.fork === false && inbox.pipeline === "1/5", "inbox");
  process.stdout.write(`${JSON.stringify({ ok: true, checksPassed: checks.length, checksTotal: checks.length, runId: raw.runId, classification: raw.classification, pipeline: "1/5", tests: `${tests.deterministicCases}+${tests.fuzzCases}`, pin: history.fixedFinalizedPin, currentKnownUsdValue: raw.currentCustody.currentKnownUsdValue, totalUsdValue: raw.currentCustody.totalUsdValue, nonconfiguredNonzeroCount: raw.currentCustody.nonconfiguredNonzeroCount, historyRows: history.tokenTransferHistory.rows, historyCommitment: history.tokenTransferHistory.exactCommitment, runtimeExact: raw.binding.publicHandler.exactRuntimeEquivalence, fork: false, gates: "0/0/false", aggregateSha256: manifest.aggregateSha256, manifestSha256: hashFile(MANIFEST).sha256, reopenTrigger: raw.reopenTrigger })}\n`);
}

try { main(); } catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, category: String(error.message || error) })}\n`); process.exit(1); }
