#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-staker-layerzero-binding";
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const REVISION = "behype-staker-layerzero-binding-step4-reviewer-r2";
const AGENT = "critical-etherfi-behype-staker-lz-r2-20260722";
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

assert.strictEqual(raw.revision, REVISION);
assert.strictEqual(raw.agentId, AGENT);
assert(raw.runId.startsWith("etherfi-behype-staker-layerzero-r2-"));
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
assert(raw.classification.startsWith("INCOMPLETE/WATCH/EXACT-STAKER-RECEIVER-BINDING"));
for (const key of ["ethSendMethodsUsed", "signingUsed", "impersonationUsed", "forkCreated", "stakeCalled", "messageSent", "retryCalled", "claimCalled", "fundsUsed", "stateMutation"]) assert.strictEqual(raw.safety[key], false, key);
assert.strictEqual(raw.safety.readOnlyRpc, true);
assert.strictEqual(raw.safety.endpointInventoryRead, true);
assert.strictEqual(raw.safety.endpointValuesPersisted, false);
assert.strictEqual(raw.providerCoverage.repairAttempt.bounded, true);
assert.strictEqual(raw.providerCoverage.repairAttempt.attemptCount, 1);
assert.strictEqual(raw.providerCoverage.repairAttempt.economicsAttempted, false);

// Explicit Optimism finalized-pin/state/terminal binding.
assert.strictEqual(raw.pin.chainId, 10);
assert.strictEqual(raw.pin.finalizedSelected, true);
assert.strictEqual(raw.pin.verified, true);
assert.strictEqual(raw.providerCoverage.optimism.finalizedConsensusCount, 3);
assert.strictEqual(raw.providerCoverage.optimism.stateConsensusCount, 2);
assert.strictEqual(raw.pin.terminalSameNumberHashThreshold, 2);
assert.strictEqual(typeof raw.pin.terminalSameNumberHashVerified, "boolean");
assert.strictEqual(raw.pin.terminalSameNumberHashMatchCount, raw.providerCoverage.optimism.terminalRecheck.matchCount);
assert.strictEqual(raw.pin.terminalSameNumberHashThreshold, raw.providerCoverage.optimism.terminalRecheck.threshold);
assert.strictEqual(raw.pin.terminalSameNumberHashVerified, raw.pin.terminalSameNumberHashMatchCount >= raw.pin.terminalSameNumberHashThreshold);
assert.strictEqual(raw.pin.terminalSameNumberHashVerified, raw.providerCoverage.optimism.terminalRecheck.verified);
const terminalWording = raw.pin.terminalSameNumberHashVerified
  ? `PASS ${raw.pin.terminalSameNumberHashMatchCount}/${raw.pin.terminalSameNumberHashThreshold} threshold met`
  : `GAPPED ${raw.pin.terminalSameNumberHashMatchCount}/${raw.pin.terminalSameNumberHashThreshold} threshold unmet`;
const handoffCoverage = `${raw.providerCoverage.optimism.finalizedConsensusCount} Optimism finalized-pin providers, ${raw.providerCoverage.optimism.stateConsensusCount} matching retained state providers, terminal same-number recheck ${terminalWording}.`;
assert(handoff.includes(handoffCoverage), "handoff Optimism coverage wording");
assert(report.includes(`${raw.providerCoverage.optimism.finalizedConsensusCount} Optimism finalized-pin providers`));
assert(report.includes(`${raw.providerCoverage.optimism.stateConsensusCount} matching retained state providers`));
assert(report.includes(`terminal same-number recheck ${terminalWording}`));
if (!raw.pin.terminalSameNumberHashVerified) {
  assert(raw.classification.includes("ACCESS-COVERAGE_OPEN"));
  assert(raw.classification.includes("OPTIMISM-TERMINAL-RECHECK-GAPPED"));
}

// Destination repair is dynamic but must fail closed unless both state and history have two providers.
const destinationRepaired = raw.providerCoverage.destination.stateConsensusCount >= 2 && raw.providerCoverage.destination.historyConsensusCount >= 2;
assert.strictEqual(raw.providerCoverage.destination.multiProviderConsensus, destinationRepaired);
assert.strictEqual(raw.destinationPin.multiProviderConsensus, destinationRepaired);
assert.strictEqual(raw.history.destination.multiProviderConsensus, destinationRepaired);
assert.strictEqual(raw.history.destination.providerCount, raw.providerCoverage.destination.historyConsensusCount);
if (!destinationRepaired) {
  assert(raw.classification.includes("ACCESS-COVERAGE_OPEN"));
  assert(raw.classification.includes("DESTINATION-SINGLE-PROVIDER"));
  assert(report.includes("single-provider event evidence"));
  assert(handoff.includes("single-provider event evidence and ACCESS/COVERAGE_OPEN"));
} else {
  assert(report.includes("independent-provider event agreement"));
  assert(handoff.includes("independent-provider event agreement"));
}
assert(report.includes("not delivery-finality proof"));
assert(handoff.includes("not delivery-finality proof"));

// Exact local rebuild scope is intentionally narrower than adapter/runtime binding.
assert.deepStrictEqual(raw.evidenceScope.localExactBuildRuntime, ["l2-staker-proxy", "l2-staker-implementation", "destination-receiver-proxy", "destination-receiver-implementation"]);
assert.strictEqual(raw.evidenceScope.fullRouteLocalExactBuildRuntimeBound, false);
assert.strictEqual(raw.evidenceScope.destinationDeliveryFinalityProven, false);
assert.deepStrictEqual(raw.evidenceScope.explorerRuntimeBoundWithoutEqualLocalRebuild, ["source-WHYPE-adapter", "source-beHYPE-adapter", "destination-WHYPE-adapter", "destination-beHYPE-adapter"]);
assert.strictEqual(raw.sourceBuilds.contracts.length, 4);
assert(raw.sourceBuilds.contracts.every((x) => x.exactRuntime === true));
for (const key of ["sourceWhype", "sourceBehype", "destinationWhypeAdapter", "destinationBehypeAdapter"]) {
  const row = raw.sourceEvidence.contracts.find((x) => x.key === key);
  assert(row && row.explorerRuntimeExact === true, `adapter runtime ${key}`);
}
assert(report.includes("adapters are explorer/runtime-bound without equal local rebuild"));
assert(handoff.includes("adapters are explorer/runtime-bound without equal local rebuild"));
assert(!/route is exactly identity\/source\/runtime bound/i.test(report));

assert.strictEqual(raw.currentBindings.module.isDefault, true);
assert.strictEqual(raw.currentBindings.module.isWhitelisted, true);
assert.strictEqual(raw.currentBindings.module.staker, raw.addresses.l2StakerProxy);
assert.strictEqual(raw.currentBindings.l2Staker.sourceRuntimeExact, true);
assert.strictEqual(raw.currentBindings.destinationReceiver.sourceRuntimeExact, true);
assert.strictEqual(raw.flow.destination.wholeBeHypeBalanceUsedNotDelta, true);
assert.strictEqual(raw.flow.destination.nativeFeePaidFromReceiverBalance, true);
assert.strictEqual(raw.flow.destination.outboundRefundRecipient, raw.addresses.destinationReceiverProxy);
assert.strictEqual(raw.layerZero.nonces.sourceWhypeOutbound, raw.layerZero.nonces.destinationWhypeInbound);
assert.strictEqual(raw.layerZero.nonces.destinationBehypeOutbound, raw.layerZero.nonces.sourceBehypeInbound);
assert.strictEqual(raw.history.optimism.complete, true);
assert.strictEqual(raw.history.optimism.consensusCount, 2);
assert.strictEqual(raw.history.route.sourceWhypeUnmatched, 0);
assert.strictEqual(raw.history.route.returnBehypeUnmatched, 0);
assert.strictEqual(raw.history.route.completeRoundTrips, raw.history.route.sourceWhypeSent);
assert.strictEqual(raw.history.route.moduleStakeJoined + raw.history.route.directPublicStakerCalls, raw.history.route.sourceWhypeSent);
assert(raw.history.route.directPublicStakerCalls > 0);
assert.strictEqual(raw.history.destinationAllSources.received - raw.history.destinationAllSources.returnSent, raw.history.destinationAllSources.unmatchedMessages);

assert.strictEqual(raw.history.destinationAllSources.unmatchedClassification, "unresolved/pending-or-failed-observation");
assert.strictEqual(raw.findings.unmatchedDestinationComposeClassification, "unresolved/pending-or-failed-observation");
assert.strictEqual(raw.findings.unmatchedDestinationComposeTreatedAsOrdinaryOperationalState, false);
assert(report.includes("unresolved/pending-or-failed observation"));
assert(handoff.includes("unresolved/pending-or-failed observation"));
assert(!report.includes("ordinary operational pending/failed state"));
assert(!handoff.includes("ordinary pending/failed state"));

assert.strictEqual(raw.findings.permissionlessDirectStakerCallsObserved, true);
assert.strictEqual(raw.findings.destinationFeeSubsidyPermissionlessReachable, true);
assert.strictEqual(raw.findings.directNativePayoutToCallerFound, false);
assert.strictEqual(raw.findings.publicWholeBalanceDeliveryCanIncludePriorBehypeResidue, true);
assert.strictEqual(raw.findings.permissionlessArbitrarySweepFound, false);
assert.strictEqual(raw.findings.ownerOnlyExplicitBehypeSweep, true);
assert.strictEqual(raw.findings.currentCompleteProfitableRouteEstablished, false);
assert.strictEqual(raw.publicValuePaths.endpointComposeRetryPermissionlessButQueueAndMessageHashBound, true);
assert(report.includes("destination receiver funds the return native fee"));
assert(report.includes("whole rounded beHYPE balance"));
assert(report.includes("owner-only"));
assert(report.includes("queue/message-hash bound"));

assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(manifest.classification, raw.classification);
assert.strictEqual(manifest.optimismFinalizedConsensusCount, raw.providerCoverage.optimism.finalizedConsensusCount);
assert.strictEqual(manifest.optimismStateConsensusCount, raw.providerCoverage.optimism.stateConsensusCount);
assert.strictEqual(manifest.optimismTerminalSameNumberHashVerified, raw.pin.terminalSameNumberHashVerified);
assert.strictEqual(manifest.optimismTerminalMatchCount, raw.pin.terminalSameNumberHashMatchCount);
assert.strictEqual(manifest.optimismTerminalThreshold, raw.pin.terminalSameNumberHashThreshold);
assert.strictEqual(manifest.destinationStateConsensusCount, raw.providerCoverage.destination.stateConsensusCount);
assert.strictEqual(manifest.destinationHistoryConsensusCount, raw.providerCoverage.destination.historyConsensusCount);
assert.strictEqual(manifest.destinationMultiProviderConsensus, destinationRepaired);
assert.strictEqual(manifest.fullRouteLocalExactBuildRuntimeBound, false);
assert.strictEqual(manifest.destinationDeliveryFinalityProven, false);
assert.strictEqual(manifest.destinationUnmatchedClassification, "unresolved/pending-or-failed-observation");
assert.strictEqual(manifest.routePositive, 0);
assert.strictEqual(manifest.executableNow, 0);
assert.strictEqual(manifest.signedActionJustified, false);
assert.strictEqual(manifest.fork, false);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(inbox.revision, REVISION);
assert.strictEqual(inbox.agentId, AGENT);

for (const rec of manifest.records) {
  const data = fs.readFileSync(abs(rec.path));
  assert.strictEqual(data.length, rec.bytes, `bytes ${rec.path}`);
  assert.strictEqual(hash(data), rec.sha256, `hash ${rec.path}`);
}
assert.strictEqual(hash(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")), manifest.aggregateSha256);
const leak = [rawText, manifestText, report, inboxText, handoff].join("\n");
assert(!/https?:\/\/[a-z0-9]/i.test(leak), "URL leak");
assert(!/[?&](?:key|token|api_key|apikey)=/i.test(leak), "credential leak");
assert(!/(authorization|cookie|set-cookie)\s*[:=]/i.test(leak), "header leak");
assert(report.includes("🟠 WATCH"));
assert(report.includes("nextReadOnlyStep"));
assert(handoff.includes(raw.runId));
process.stdout.write(`PASS EtherFi BeHYPE staker/LayerZero Step 4 reviewer r2 (${raw.runId}; op-terminal=${raw.pin.terminalSameNumberHashMatchCount}/${raw.pin.terminalSameNumberHashThreshold}; destination-state/history=${raw.providerCoverage.destination.stateConsensusCount}/${raw.providerCoverage.destination.historyConsensusCount}; aggregate=${manifest.aggregateSha256})\n`);
