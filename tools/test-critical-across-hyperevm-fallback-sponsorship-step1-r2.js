#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-across-hyperevm-fallback-sponsorship-step1-r2";
const PRE = "critical-across-hyperevm-fallback-sponsorship-step1";
const RAW = `reports/raw/fast/${NAME}.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const LEAK = `reports/raw/fast/${NAME}-leak-scan.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const HISTORICAL = `reports/raw/fast/${NAME}-predecessor-scanner.js`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/review-${NAME}-2026-07-24.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const WRAPPER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const PRE_MANIFEST = `reports/raw/fast/${PRE}-manifest.json`;
const PRE_SCANNER = `tools/scan-${PRE}.js`;
const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel));
const json = (rel) => JSON.parse(read(rel).toString("utf8"));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (rel) => { const body = read(rel); return { path: rel, bytes: body.length, sha256: sha(body) }; };
function assert(ok, label, checks) { checks.push({ label, passed: !!ok }); if (!ok) throw new Error(label); }

function main() {
  const required = [RAW, TESTS, LEAK, MANIFEST, HISTORICAL, REPORT, INBOX, HANDOFF, WRAPPER, VALIDATOR, PRE_MANIFEST, PRE_SCANNER];
  for (const rel of required) if (!fs.existsSync(abs(rel))) throw new Error(`missing:${rel}`);
  const raw = json(RAW), tests = json(TESTS), leak = json(LEAK), manifest = json(MANIFEST), preManifest = json(PRE_MANIFEST), inbox = json(INBOX), checks = [];
  assert(raw.classification === "WATCH/COVERAGE-OR-BINDING-GAP/FAIL-CLOSED/REVIEWER-R2", "classification-fail-closed", checks);
  assert(raw.pipeline.stage === 1 && raw.pipeline.callbackReachabilitySurvives === false && raw.pipeline.cctpCallbackReachabilityExact === null, "pipeline-1-of-5", checks);
  assert(raw.gates.routePositive === 0 && raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false && raw.gates.fork === false, "gates-closed", checks);
  assert(raw.drift.benign && raw.drift.evidence.exactHistoricalBytesRecovered && raw.drift.semanticOutputReplay.passed, "benign-drift-semantic-replay", checks);
  assert(raw.drift.evidence.diff.executableLogicChanged === false && raw.drift.evidence.diff.changedLines.join(",") === "347,349" && raw.drift.evidence.diff.byteDelta === 255, "two-line-message-only-diff", checks);
  assert(hashFile(HISTORICAL).bytes === 39049 && hashFile(HISTORICAL).sha256 === "105bf33bbf6bf649c40b94d83ffa77ab11217dc95103bf1c8b40eb4d0d300927", "historical-scanner-exact", checks);
  assert(hashFile(PRE_SCANNER).bytes === 39304 && hashFile(PRE_SCANNER).sha256 === "b2c5a89bac983c9b5fbb8e126277e081a0a84aa5c7873665b5e846dd5e084512", "current-scanner-bound", checks);
  assert(raw.predecessor.claimedAggregateSha256 === "59c2248b5718ecaf6e2f6af648adc13c9f91df215b15831fbb9e861f8d270479" && raw.predecessor.replayedAggregateSha256 === raw.predecessor.claimedAggregateSha256, "predecessor-aggregate-exact", checks);
  assert(raw.predecessor.recursiveRecordCount === 11 && raw.predecessor.originalCapturePreservedUnmodified, "recursive-predecessor-closure", checks);
  assert(raw.predecessor.currentFilesystemAudit.filter((row) => !row.matches).length === 1 && raw.predecessor.currentFilesystemAudit.find((row) => !row.matches).path === PRE_SCANNER, "only-scanner-drifted", checks);
  assert(raw.sourceReview.checks.fallbackCallOrderExact && raw.sourceReview.sharedReentrancyGuardCoverageVerified, "call-order-and-shared-guard", checks);
  assert(raw.sourceReview.nonceBeforeValueFlowInteractionVerified && raw.sourceReview.checks.cctpTransportInteractionPrecedesNonceQualifiedCaveat, "qualified-nonce-order", checks);
  assert(raw.sourceReview.directSelectorRejectionRetained, "direct-selector-rejected", checks);
  assert(raw.sourceReview.underDeliveryPrimitiveVerified && raw.sourceReview.underDeliveryCallOrder.includes("requested counter"), "under-delivery-counter-primitive", checks);
  assert(raw.sourceReview.historyReplay.fallbackEventCount === 277 && raw.sourceReview.historyReplay.receiptsChecked === 277 && raw.sourceReview.historyReplay.allRowsExact, "277-flow-reconciliation", checks);
  assert(raw.sourceReview.activeBindings.modulesExact && raw.sourceReview.activeBindings.donationBoxesExact && raw.sourceReview.activeBindings.oftHandlerExact, "active-oft-module-donation-bindings", checks);
  assert(raw.sourceReview.activeBindings.cctpHandlersExact === false && raw.sourceReview.activeBindings.cctpNormalizedFamilyAgreement, "cctp-mismatch-caveat", checks);
  assert(raw.sourceReview.retainedCapture.pin.finalizedSelected && raw.sourceReview.retainedCapture.pin.terminalRecheckPassed && raw.sourceReview.retainedCapture.strictQualifiedFamilyCount === 10 && raw.sourceReview.retainedCapture.historyFamilyCount === 2, "retained-pin-family-terminal", checks);
  assert(raw.sourceReview.retainedCapture.newCapturePerformed === false && raw.sourceReview.deployedAttackerDelta === "0", "no-new-capture-no-attacker-delta", checks);
  assert(tests.build.passed && tests.solidity.passed && tests.currentScannerSyntax.passed, "build-tests-syntax-pass", checks);
  assert(tests.solidity.fixedAndFuzzFunctions === 17 && tests.solidity.fuzzFunctions === 3 && tests.solidity.fuzzExecutions === 771 && tests.solidity.totalEffectiveCases === 785, "test-counts", checks);
  assert(tests.predecessorValidatorReplay.expectedFailureObserved && tests.predecessorValidatorReplay.category === `record:${PRE_SCANNER}`, "root-failure-reproduced", checks);
  assert(leak.passed && leak.findingCount === 0 && leak.endpointInventoryCompared === false, "leak-scan", checks);
  assert(Object.entries(raw.activityScope).every(([key, value]) => !["endpointInventoryReads", "rpcCalls", "httpRequests", "liveActions", "signedTransactions", "broadcasts", "privateKeyReads", "envFileReads", "originalArtifactEdits", "originalClaimEdits"].includes(key) || value === 0), "offline-activity-scope", checks);
  assert(raw.activityScope.forkCreated === false && raw.activityScope.productionMutation === false, "no-fork-or-production-mutation", checks);
  assert(inbox.runId === raw.runId && inbox.routePositive === 0 && inbox.fork === false, "inbox-binding", checks);
  assert(manifest.recursivePredecessor.claimedAggregateSha256 === preManifest.aggregateSha256 && manifest.recursivePredecessor.replayedAggregateSha256 === preManifest.aggregateSha256, "manifest-predecessor-binding", checks);
  const records = manifest.records.map((record) => { const actual = hashFile(record.path); assert(actual.bytes === record.bytes && actual.sha256 === record.sha256, `record:${record.path}`, checks); return actual; });
  const aggregate = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  assert(aggregate === manifest.aggregateSha256, "manifest-aggregate", checks);
  const recursive = manifest.recursivePredecessor.files;
  for (const row of recursive) {
    const actual = row.path === PRE_SCANNER && row.sha256 === "105bf33bbf6bf649c40b94d83ffa77ab11217dc95103bf1c8b40eb4d0d300927" ? hashFile(HISTORICAL) : hashFile(row.path);
    assert(actual.bytes === row.bytes && actual.sha256 === row.sha256, `recursive-record:${row.path}:${row.sha256.slice(0, 12)}`, checks);
  }
  const recursiveAggregate = sha(Buffer.from(recursive.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  assert(recursiveAggregate === manifest.recursivePredecessor.recursiveFilesAggregateSha256, "recursive-files-aggregate", checks);
  process.stdout.write(JSON.stringify({ ok: true, checksPassed: checks.filter((x) => x.passed).length, checksTotal: checks.length, runId: raw.runId, classification: raw.classification, pipeline: "1/5", tests: tests.solidity, predecessorAggregateSha256: raw.predecessor.replayedAggregateSha256, currentScannerSha256: hashFile(PRE_SCANNER).sha256, historicalScannerSha256: hashFile(HISTORICAL).sha256, aggregateSha256: aggregate, nextGate: raw.nextGate }) + "\n");
}

try { main(); } catch (error) { process.stderr.write(JSON.stringify({ ok: false, category: String(error.message || error) }) + "\n"); process.exit(1); }
