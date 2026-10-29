#!/usr/bin/env node
"use strict";
// Check-only validator. This file deliberately contains no filesystem write call.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const generator = require("./generate-critical-yearn-v3-step2-manifest");

const ROOT = path.resolve(__dirname, "..");
const RAW_REL = "reports/raw/fast/critical-yearn-v3-tokenized-strategy-accounting-step2.json";
const REPORT_REL = "reports/critical-yearn-v3-tokenized-strategy-accounting-step2.md";
const INBOX_REL = "coordination/inbox/critical/yearn-v3-tokenized-strategy-accounting-step2.json";
const HANDOFF_REL = "coordination/handoffs/2026-07-27-critical-yearn-v3-step2.md";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function read(rel) { return fs.readFileSync(path.join(ROOT, rel)); }
function exactlyTrueTerminal(rows, expected = 2) { return Array.isArray(rows) && rows.length === expected && rows.every(x => x && x.sameHash === true && x.finalizedAtOrAbove === true); }
function assertion(value, message, state) { if (!value) throw new Error(`VALIDATION_FAILED:${message}`); state.checks++; }

function validateData(raw, report, inbox, handoff) {
  const state = { checks: 0 }, check = (v, m) => assertion(v, m, state), expectedClass = "WATCH/CONDITIONAL-PRIMITIVE/CURRENT-DAI-CANDIDATE/MODEL-NOT-ESTABLISHED/EXIT-UNPROVEN/NET-ECONOMICS-UNRESOLVED";
  check(raw.schemaVersion === 2 && raw.revision >= 4, "schema/revision");
  check(raw.classification === expectedClass && inbox.classification === expectedClass, "classification");
  check(raw.pipeline.stage === 2 && raw.pipeline.economicsResolved === false && raw.pipeline.candidateRouteNegative === false && raw.pipeline.netEconomics === false && raw.pipeline.modelEstablished === false, "pipeline economics unresolved");
  check(raw.gates.routePositive === false && raw.gates.executableNow === false && raw.gates.signedActionJustified === false && raw.gates.fork === false, "gates");
  check(raw.pin.chainId === 1 && raw.pin.number === 25629997 && raw.pin.hash === "0x0a8092afdb0d9d5f73b8a181d8f79a281a416a0d9d96fa047c5aac58af72d02f", "fixed pin");
  check(exactlyTrueTerminal(raw.pin.initialCaptureTerminalRecheck), "initial terminal exact true");
  check(exactlyTrueTerminal(raw.pin.stateRefreshTerminalRecheck), "refresh terminal exact true");
  check(exactlyTrueTerminal(raw.daiOpportunityQueryCoverage.terminalRecheck), "DAI terminal exact true");
  check(raw.daiOpportunityQueryCoverage.agreeingStateFamilies === 2 && raw.daiOpportunityQueryCoverage.exactDsrAgreement === true, "two-family DSR agreement");
  check(raw.daiOpportunityQueryCoverage.backendOperatorIndependenceEstablished === false, "no independence claim");
  check(raw.discovery.eventClassifiedStrategiesInDiscoveredVaultJoinedUniverse === 22 && raw.discovery.globalStrategyDeploymentCount === null && raw.discovery.historySingleFamily === true, "corrected strategy count/scope");
  check(!Object.hasOwn(raw.discovery, "exactTokenizedStrategies") && !Object.hasOwn(raw, "exactStrategies"), "misleading global/exact fields removed");
  check(Array.isArray(raw.eventClassifiedStrategies) && raw.eventClassifiedStrategies.length === 22, "event-classified strategy rows");
  check(raw.grossCounterfactualCandidates.length === 1 && raw.watchCandidates.length === 0, "counterfactual versus live candidate split");
  const c = raw.grossCounterfactualCandidates[0], e = raw.economicSensitivity, cost = e.daiPotBenchmark;
  check(c.binding.customStrategyShellRuntimeExact === false && c.binding.customHooksExact === false, "custom shell/hooks unproven");
  check(c.binding.baseStrategyFallbackDispatchProvenBySlot === false && c.strategyState.implementationSlotRole.includes("fallback dispatches") && c.strategyState.implementationSlotRole.includes("not this slot"), "slot informational");
  check(c.strategyState.maxDepositMeaning.includes("Quoted receiver capacity only"), "maxDeposit quote only");
  check(c.reportSimulation.returnSemantics.includes("simulated strategy harvest/sales") && c.reportSimulation.returnSemantics.includes("not independently measured"), "report return semantics");
  check(c.directRoute.entry === "direct TokenizedStrategy deposit" && c.directRoute.parentVaultProcessReportRequired === false && c.directRoute.parentVaultRouteEstablished === false, "direct route only");
  check(c.strategyState.hypotheticalPostReportWeightedUnlockSeconds === null && c.strategyState.hypotheticalPostReportFullProfitUnlockDate === null, "hypothetical weighted unlock absent");
  check(c.exitFeasibility.established === false && c.exitFeasibility.mandatoryOnlyIfEconomicsSurvives === true, "exit feasibility absent");
  check(c.reportHistory.count === 142 && c.reportHistory.cadencePredictabilityEstablished === false && c.reportHistory.reportIntervalDistribution === null && c.reportHistory.actionableTimingEstablished === false, "history does not establish timing");
  check(e.disposition === "NON_PROMOTING_DSR_SENSITIVITY_ONLY" && e.economicsResolved === false && e.routeNegativeEstablished === false && e.routePositiveEstablished === false, "economic disposition unresolved");
  check(e.counterfactual.assetsRaw === "1269083508555249382456318" && e.counterfactual.attackerDepositRaw === e.counterfactual.assetsRaw, "A=x");
  check(e.counterfactual.reportReturnRaw === "11818666578642154609" && e.counterfactual.performanceFeeBps === "0", "p/fee");
  check(e.counterfactual.grossCaptureRaw === "5909333289321077304" && e.counterfactual.exactFormula === "x*p/(A+x)=floor(p/2)", "gross formula");
  check(e.counterfactual.grossRatePercent === "0.0004656" && e.counterfactual.breakEvenAnnualizedBps3d === "5.6652" && e.counterfactual.breakEvenAnnualizedBps10d === "1.6995", "break-even rates");
  check(e.counterfactual.durationSeconds === "259200" && e.counterfactual.durationMeaning.includes("maximizes this modeled DSR amount") && e.counterfactual.durationMeaning.includes("not a conservative closure duration"), "duration qualification");
  check(cost.contract === "0x197E90f9FAD81970bA7976f33CbD77088E5D7cf7" && cost.dsrRay === "1000000000393915525145987602", "official DAI Pot state");
  check(cost.stateFamilies === 2 && cost.exactDsrAgreement === true && cost.effectiveAnnualBps === "124.9999", "DSR rate semantics/agreement");
  check(cost.growthRay === "1000102108116776650997819865" && cost.modeledThreeDayAmountRaw === "129583727090881369588", "exact DSR sensitivity arithmetic");
  check(cost.benchmarkOnly === true && cost.opportunityCostFloorEstablished === false && cost.exactCapitalPublicAccessAndCapacityEstablished === false && cost.ratePersistenceEstablished === false && cost.concurrentStrategyYieldBound === false, "benchmark not floor");
  check(e.threeDayDifferenceSensitivity.partialGrossRaw === e.counterfactual.grossCaptureRaw && e.threeDayDifferenceSensitivity.modeledDsrAmountRaw === cost.modeledThreeDayAmountRaw && e.threeDayDifferenceSensitivity.arithmeticDifferenceRawSigned === "-123674393801560292284" && e.threeDayDifferenceSensitivity.interpretation.includes("not net economics"), "sensitivity not net result");
  check(e.gasSensitivity.daiCostLowerBoundRaw === "0" && e.gasSensitivity.intrinsicGasUnitsLowerBound === "42000" && e.gasSensitivity.intrinsicBaseFeeWeiLowerBound === "3626055636000" && e.gasSensitivity.usedForClosure === false && e.gasSensitivity.daiFloorReason.includes("no economic closure claimed"), "gas sensitivity not closure");
  check(c.allAttackerCashflowModel.complete === false && c.allAttackerCashflowModel.alreadyUnlockingProfitIncluded === false && c.allAttackerCashflowModel.ordinaryStrategyYieldDuringHoldIncluded === false && c.allAttackerCashflowModel.shortestFeasibleHoldingPeriod === null && c.allAttackerCashflowModel.partialExitCashflows === null, "all-attacker cashflow incomplete");
  check(raw.safety.endpointMaterialPersisted === false && raw.safety.providerIdentitiesPersisted === false && raw.safety.rawResponsesPersisted === false, "endpoint safety");
  check(raw.safety.signedTransactions === false && raw.safety.broadcast === false && raw.safety.stateMutation === false && raw.safety.fork === false && raw.safety.stateOverride === false, "execution safety");
  check(report.includes("not global deployments") && report.includes("slot is informational") && report.includes("receiver-capacity quote"), "report claim corrections");
  check(report.includes("keeper-authorized `report()` simulation returned") && report.includes("not independently measured unrealized profit"), "report simulation correction");
  check(report.includes("Parent-vault `process_report`") && report.includes("actual post-hypothetical weighted unlock") && report.includes("142 retained reports do not prove cadence"), "route/unlock/cadence corrections");
  check(report.includes("129.583727090881369588 DAI") && report.includes("-123.674393801560292284 DAI") && report.includes("non-promoting sensitivity only") && report.includes("not a capital-cost floor"), "report sensitivity wording");
  check(report.includes("already-unlocking profit") && report.includes("ordinary strategy yield") && report.includes("neither route-negative nor route-positive"), "report incomplete cashflows/economics");
  check(handoff.includes("not global; history single-family") && handoff.includes("benchmark sensitivity only—not a floor") && handoff.includes("Economics unresolved"), "handoff corrections");
  check(inbox.runId === raw.runId && inbox.status === "model-not-established-net-economics-unresolved" && inbox.economicSensitivity.economicsResolved === false, "inbox binding");
  check(raw.finalCorrectionActivity.offlineOnly === true && raw.finalCorrectionActivity.networkReads === 0 && raw.finalCorrectionActivity.rpcReads === 0 && raw.finalCorrectionActivity.historyReads === 0 && raw.finalCorrectionActivity.stateQueries === 0, "offline-only final correction");
  for (const [name, text] of [[RAW_REL, JSON.stringify(raw)], [REPORT_REL, report], [INBOX_REL, JSON.stringify(inbox)], [HANDOFF_REL, handoff]]) { check(!/(?:https?|wss?):\/\//i.test(text), `${name} endpoint URL leak`); check(!/"(?:url|headers|apiKey|token|rawResponse|responseBody)"\s*:/i.test(text), `${name} forbidden field`); }
  return state;
}

function verifyManifest(manifest) {
  const state = { checks: 0 }, check = (v, m) => assertion(v, m, state);
  check(manifest.schemaVersion === 2 && manifest.validatorMode === "check-only", "manifest schema/mode");
  check(manifest.generator === "tools/generate-critical-yearn-v3-step2-manifest.js", "manifest generator");
  check(JSON.stringify(manifest.files.map(x => x.path)) === JSON.stringify(generator.FILES), "manifest file set/order");
  for (const row of manifest.files) { const body = read(row.path); check(row.bytes === body.length, `${row.path} bytes`); check(row.sha256 === sha(body), `${row.path} hash`); }
  const expected = sha(generator.canonical(manifest.files.map(x => ({ path: x.path, bytes: x.bytes, sha256: x.sha256 })))); check(manifest.aggregateSha256 === expected, "aggregate hash");
  return state;
}

function validatePackage(options = {}) {
  const raw = JSON.parse(read(RAW_REL)), report = read(REPORT_REL).toString("utf8"), inbox = JSON.parse(read(INBOX_REL)), handoff = read(HANDOFF_REL).toString("utf8"), data = validateData(raw, report, inbox, handoff);
  let manifestChecks = 0; if (options.checkManifest !== false) { const manifest = JSON.parse(read(generator.MANIFEST_REL)); manifestChecks = verifyManifest(manifest).checks; }
  return { dataChecks: data.checks, manifestChecks, checks: data.checks + manifestChecks };
}

if (require.main === module) { const before = fs.existsSync(path.join(ROOT, generator.MANIFEST_REL)) ? sha(read(generator.MANIFEST_REL)) : null, result = validatePackage({ checkManifest: !process.argv.includes("--data-only") }), after = fs.existsSync(path.join(ROOT, generator.MANIFEST_REL)) ? sha(read(generator.MANIFEST_REL)) : null; if (before !== after) throw new Error("VALIDATOR_WROTE_MANIFEST"); process.stdout.write(`${JSON.stringify({ status: "PASS", mode: "check-only", ...result, manifestUnchanged: before === after })}\n`); }
module.exports = { exactlyTrueTerminal, validateData, verifyManifest, validatePackage };
