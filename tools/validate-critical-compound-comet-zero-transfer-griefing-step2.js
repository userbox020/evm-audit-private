#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, ".."), NAME = "critical-compound-comet-zero-transfer-griefing-step2";
const RAW = `reports/raw/fast/${NAME}.json`, TESTS = `reports/raw/fast/${NAME}-tests.json`, LEAK = `reports/raw/fast/${NAME}-leak-scan.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`;
const abs = (rel) => path.join(ROOT, rel), body = (rel) => fs.readFileSync(abs(rel)), text = (rel) => body(rel).toString("utf8"), json = (rel) => JSON.parse(text(rel));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const checks = [];
function check(name, predicate) { const passed = Boolean(predicate); checks.push({ name, passed }); if (!passed) throw new Error(name); }

function main() {
  for (const rel of [RAW, TESTS, LEAK, MANIFEST, REPORT]) check(`exists:${rel}`, fs.existsSync(abs(rel)));
  const raw = json(RAW), tests = json(TESTS), leak = json(LEAK), manifest = json(MANIFEST), report = text(REPORT);
  check("schema", raw.schemaVersion === 2 && manifest.schemaVersion === 2 && raw.revision === "oracle-scope-and-gas-corrections-offline-r2");
  check("role", raw.role === "critical-research");
  check("classification", raw.classification.startsWith("LOW/CURRENTLY-REACHABLE-AT-FINALIZED-PIN/"));
  check("pipelines", raw.pipelines.impactPrimitive === "2/5" && raw.pipelines.financialExtraction === "0/5" && raw.pipelines.deploymentBound === true && raw.pipelines.matchingEventDerivedUniverseAtPin === true && raw.pipelines.completeHistoricalExposureAtPin === false && raw.pipelines.marketWideCompletenessEstablished === false);
  check("no-payout", raw.pipelines.directAttackerPayoutDemonstrated === false && raw.economics.directPayoutDemonstrated === false && raw.economics.attackerBaseGainRaw === "0" && raw.economics.attackerCollateralGainRaw === "0" && raw.economics.attackerRewardGainRaw === "0");
  check("gates", raw.gates.routePositive === 0 && raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false);
  check("chain", raw.endpointCoverage.chainId === 1);
  check("two-families", raw.endpointCoverage.selectedHostnameDerivedFamilies === 2 && raw.endpointCoverage.backendOperatorIndependenceEstablished === false);
  check("pin", Number.isInteger(raw.endpointCoverage.fixedFinalizedPin.number) && /^0x[0-9a-f]{64}$/.test(raw.endpointCoverage.fixedFinalizedPin.hash) && raw.endpointCoverage.fixedFinalizedPin.terminalRecheck === true);
  check("no-endpoints", raw.endpointCoverage.endpointMaterialPersisted === false && raw.activityScope.endpointMaterialPersisted === false);
  check("no-raw", raw.endpointCoverage.rawResponsesPersisted === false && raw.activityScope.rawResponsesPersisted === false);
  check("no-addresses", raw.endpointCoverage.accountAddressesPersisted === false && raw.historicalCoverage.accountAddressesPersisted === false && raw.matchingEventDerivedUniverseExposure.addressRowsPersisted === 0 && raw.activityScope.accountAddressesPersisted === false);
  check("source-commit", raw.sourceContinuity.commit === "ed6ebcd84ac00906e8e725716891d482f4bef8b9");
  check("no-equivalence-overclaim", raw.sourceContinuity.runtimeEquivalenceEstablished === false && /No reproducible/.test(raw.sourceContinuity.equivalenceReason));
  check("deployment", raw.deployment.market === "Ethereum Mainnet Compound III USDC" && raw.deployment.localRootsArtifactMatched && raw.deployment.baseTokenMatchesLocalConfiguration && raw.deployment.cometProxy.implementationSlotNonzero && raw.deployment.cometProxy.adminSlotNonzero);
  check("runtime-hash", /^0x[0-9a-f]{64}$/.test(raw.deployment.cometProxy.implementationRuntimeKeccak256));
  check("extended-list", raw.deployment.extendedAssetListNonzero === true && raw.deployment.extendedAssetListHasCode === true && raw.deployment.extensionDelegateHasCode === true);
  check("history-range", raw.historicalCoverage.fromProxyFirstCodeBlock <= raw.historicalCoverage.toFixedFinalizedBlock && raw.historicalCoverage.twoFamilyMatchingLogAgreement === true);
  check("history-boundary-caveat", raw.historicalCoverage.firstCodeBoundarySelectedFamilyDerived === true && raw.historicalCoverage.fullImplementationLineageProven === false && raw.historicalCoverage.eventEmissionCompletenessProven === false);
  check("history-count", raw.historicalCoverage.logRows > 0 && raw.historicalCoverage.discoveredCandidateAccounts === raw.matchingEventDerivedUniverseExposure.discoveredCandidateAccounts);
  check("history-commitments", [raw.historicalCoverage.logCommitment, raw.historicalCoverage.accountUniverseCommitment, raw.historicalCoverage.userStateCommitment].every((value) => /^[0-9a-f]{64}$/.test(value)));
  const exposure = raw.matchingEventDerivedUniverseExposure;
  check("scope-narrowed", exposure.scope === "MATCHING_EVENT_DERIVED_UNIVERSE_UNDER_STATED_RPC_EVENT_COVERAGE_ASSUMPTIONS" && exposure.exactForDiscoveredUniverse === true && exposure.cryptographicallyCompleteMarketUniverse === false && exposure.marketWideInterpretation === "AT_LEAST_THE_ENUMERATED_EXPOSURE");
  check("corrected-exact-facts", exposure.discoveredCandidateAccounts === 13720 && exposure.enumeratedPositiveSupplyAccounts === 3356 && exposure.enumeratedNonFixedPositiveAccounts === 3356 && exposure.enumeratedOneIndependentCallLossRaw === "4006");
  check("enumerated-gap", exposure.totalSupplyBaseMinusEnumeratedPositivePrincipal === "73");
  check("exposure-shape", exposure.enumeratedPositiveSupplyAccounts >= exposure.enumeratedNonFixedPositiveAccounts && BigInt(exposure.enumeratedPositivePrincipal) >= 0n && BigInt(exposure.enumeratedCounterfactualFixedPointClaimLossRaw) >= BigInt(exposure.enumeratedOneIndependentCallLossRaw));
  check("calls-match-residue", BigInt(exposure.counterfactualCallsToEnumeratedFixedPoints) === BigInt(exposure.enumeratedResiduePrincipal));
  check("legacy-exposure-removed", !Object.hasOwn(raw, "aggregateExposure"));
  check("behavior", raw.readOnlyBehavior.behaviorConfirmed === raw.pipelines.behaviorConfirmed && raw.sourceContinuity.currentImplementationBehaviorConfirmedByReadOnlySimulation === raw.readOnlyBehavior.behaviorConfirmed);
  if (raw.readOnlyBehavior.behaviorConfirmed) {
    for (const key of ["transfer", "transferAsset"]) {
      const row = raw.readOnlyBehavior[key];
      check(`${key}-probe`, row.callSuccess === true && row.sourcePrincipalZero === true && row.victimPrincipalDecrement === "1" && row.aggregateSupplyPrincipalUnchanged === true);
    }
  }
  check("no-individual", raw.readOnlyBehavior.selectedAccountIdentityPersisted === false && raw.readOnlyBehavior.selectedAccountIndividualBalancePersisted === false);
  check("gas-scenario", raw.gasMateriality.scenario === "UNBATCHED_INDEPENDENT_CALLS" && raw.gasMateriality.independentCallEstimateGas === "107991" && raw.gasMateriality.enumeratedIndependentCalls === 3356 && raw.gasMateriality.unbatchedIndependentCallGas === "362417796");
  check("gas-economics", raw.gasMateriality.unbatchedIndependentCallScenario.nominalCostUsd === "829.832108" && raw.gasMateriality.unbatchedIndependentCallScenario.nominalLossUsd === "0.004006" && raw.gasMateriality.unbatchedIndependentCallScenario.griefLeveragePpm === "4");
  check("gas-no-block-bound", !Object.hasOwn(raw.gasMateriality, "maxEstimatedCallsPerBlock") && !Object.hasOwn(raw.gasMateriality, "minimumBlocksForSnapshotOnePass") && !Object.hasOwn(raw.gasMateriality, "minimumBlocksForCounterfactualConvergence") && !Object.hasOwn(raw.gasMateriality, "pinGasLimit"));
  check("gas-optimization-caveat", raw.gasMateriality.optimizedCampaignMeasured === false && raw.gasMateriality.optimizedCampaignCaveat.includes("reuse the source checkpoint") && raw.gasMateriality.optimizedCampaignCaveat.includes("wrapper overhead") && raw.gasMateriality.nominalAssumption.includes("no attacker revenue"));
  check("activity", raw.activityScope.liveSignedTransactions === 0 && raw.activityScope.broadcasts === 0 && raw.activityScope.localTransactions === 0 && raw.activityScope.stateOverrides === 0 && raw.activityScope.forkCreated === false && raw.activityScope.productionMutation === false && raw.activityScope.realFundsUsed === false && raw.activityScope.keyFilesRead === 0);
  check("offline-correction", raw.offlineCorrectionActivity.offlineOnly === true && raw.offlineCorrectionActivity.newRpcRequests === 0 && raw.offlineCorrectionActivity.endpointInventoryReads === 0 && raw.offlineCorrectionActivity.secretFilesRead === 0 && raw.offlineCorrectionActivity.forks === 0 && raw.offlineCorrectionActivity.liveActions === 0);
  check("tests", tests.passed === true && tests.deterministicCases === 12 && tests.fuzzCases === 4096 && tests.liveTransactions === 0 && tests.forkCreated === false && tests.eventDerivedScopeNarrowingChecked && tests.marketCompletenessOverclaimRejected && tests.unbatchedGasScenarioRequired);
  check("leak", leak.schemaVersion === 2 && leak.passed === true && leak.findingCount === 0 && leak.endpointUrlsDomainsHeadersKeysPersisted === false && leak.accountOrTargetAddressesPersisted === false && leak.secretInventoriesReadDuringCorrection === 0);
  check("report-signal", report.startsWith("# 🟡 VULNERABLE") || report.startsWith("# 🟢 DORMANT"));
  check("report-gates", report.includes("**gates:** `0/0/false`") && report.includes("currently reachable at the finalized pin"));
  check("report-scope", report.includes("matching event-derived universe") && report.includes("not a cryptographically complete account universe or market history") && report.includes("Market-wide exposure is **at least**"));
  check("report-gas", report.includes("unbatched independent calls") && report.includes("107991 gas × 3356 = 362417796 gas") && report.includes("no optimized campaign gas or block-capacity bound was measured"));
  check("report-no-overclaim", !report.includes("Complete agreed event-derived candidate universe") && !report.includes("complete account universe/history") && !report.includes("555 estimated calls/block") && !report.includes("at least 7 blocks"));
  check("manifest-run", manifest.runId === raw.runId && manifest.classification === raw.classification);
  check("manifest-pin", manifest.fixedFinalizedPin.number === raw.endpointCoverage.fixedFinalizedPin.number && manifest.fixedFinalizedPin.hash === raw.endpointCoverage.fixedFinalizedPin.hash);
  check("manifest-scope", manifest.matchingEventDerivedUniverseExposure.scope === exposure.scope && !Object.hasOwn(manifest, "aggregateExposure"));
  check("manifest-tests", manifest.tests.passed === true && manifest.tests.deterministicCases === 12 && manifest.tests.fuzzCases === 4096);
  check("manifest-records", manifest.records.length >= 14 && manifest.records.every((row) => fs.existsSync(abs(row.path)) && body(row.path).length === row.bytes && sha(body(row.path)) === row.sha256));
  const computed = sha(Buffer.from(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  check("aggregate", computed === manifest.aggregateSha256);
  check("no-urls", [RAW, TESTS, LEAK, MANIFEST, REPORT].every((rel) => !/(?:https?|wss?):\/\//i.test(text(rel))));
  check("no-address-shaped-values", [RAW, TESTS, LEAK, MANIFEST, REPORT].every((rel) => !/0x[0-9a-f]{40}(?![0-9a-f])/i.test(text(rel))));
  process.stdout.write(`${JSON.stringify({ ok: true, passed: checks.length, failed: 0, classification: raw.classification, behaviorConfirmed: raw.readOnlyBehavior.behaviorConfirmed, aggregateSha256: manifest.aggregateSha256 })}\n`);
}

try { main(); }
catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, passed: checks.filter((row) => row.passed).length, failed: checks.filter((row) => !row.passed).map((row) => row.name), category: String(error.message || error) })}\n`); process.exit(1); }
