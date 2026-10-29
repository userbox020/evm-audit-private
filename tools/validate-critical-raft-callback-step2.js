#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

if (process.argv.length !== 3 || process.argv[2] !== "--check-only") {
  console.error("usage: node tools/validate-critical-raft-callback-step2.js --check-only");
  process.exit(2);
}

const ROOT = path.resolve(__dirname, "..");
const RAW = "reports/raw/fast/critical-raft-callback-cross-entry-step2-capture.json";
const SUMMARY = "reports/raw/fast/critical-raft-callback-cross-entry-step2.json";
const REPORT = "reports/critical-raft-callback-cross-entry-step2.md";
const RUNNER = "tools/capture-critical-raft-callback-step2.js";
const TESTER = "tools/test-critical-raft-callback-step2.js";
const TESTS = "reports/raw/fast/critical-raft-callback-cross-entry-step2-tests.txt";
const INBOX = "coordination/inbox/critical/2026-07-30-critical-raft-callback-step2.json";
const HANDOFF = "coordination/handoffs/2026-07-30-critical-raft-callback-step2-handoff.md";
const MANIFEST = "reports/raw/fast/critical-raft-callback-cross-entry-step2-manifest.json";
const CLASSIFICATION =
  "CONDITIONAL-HIGH-SOURCE-IMPACT/CURRENT-CALLBACK-EXPOSURE-UNESTABLISHED/COMPLETE-ADMISSION-HISTORY-AT-PIN/DEPLOYED-RUNTIME-SOURCE-CONTINUITY-PARTIAL";

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
}
function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}
function json(relative) {
  return JSON.parse(read(relative));
}
function sha256(relative) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, relative))).digest("hex");
}

const raw = json(RAW);
const summary = json(SUMMARY);
const report = read(REPORT);
const runner = read(RUNNER);
const tester = read(TESTER);
const tests = read(TESTS);
const inbox = json(INBOX);
const handoff = read(HANDOFF);
const manifest = json(MANIFEST);
const positionManager = read("targets/raft/contracts/PositionManager.sol");
const interestManager = read("targets/raft/contracts/InterestRates/InterestRatePositionManager.sol");
const erc20RMinter = read("targets/raft/contracts/common/ERC20RMinter.sol");
const basePSM = read("targets/raft/contracts/PSM/BasePSM.sol");
const wrapped = read("targets/raft/contracts/WrappedCollateralToken.sol");
const split = read("targets/raft/contracts/SplitLiquidationCollateral.sol");
const priceFeed = read("targets/raft/contracts/PriceFeed.sol");
const wbtcTest = read("targets/raft/test/PositionManagerWBTC.t.sol");

check(raw.classification === CLASSIFICATION, "raw classification mismatch");
check(summary.classification === CLASSIFICATION, "summary classification mismatch");
check(inbox.status === CLASSIFICATION, "inbox classification mismatch");
check(report.includes(CLASSIFICATION), "report classification absent");
check(handoff.includes(CLASSIFICATION), "handoff classification absent");
check(raw.gates.localSourceRoutePositive === 1, "local source gate mismatch");
check(raw.gates.currentRouteExistence === null && raw.gates.currentRoutePositive === null, "current route existence must remain null");
check(raw.gates.operationalRoutePositive === 0 && raw.gates.routePositive === 0, "operational gates must be zero");
check(raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false && raw.gates.fork === false, "execution gates open");
check(raw.pin.finalized === true && /^\d+$/.test(raw.pin.number) && /^0x[0-9a-f]{64}$/.test(raw.pin.hash), "pin noncanonical");
check(raw.pin.familyAgreement >= 2, "two-family pin agreement absent");
check(raw.coverage.selectedStateFamilies >= 2 && raw.coverage.stateAgreement === true, "state agreement absent");
check(raw.coverage.backendIndependenceClaim === false, "backend independence must not be claimed");
check(raw.coverage.terminalExactNumberHash.passed === true, "terminal recheck failed");
check(raw.coverage.terminalExactNumberHash.rows.length === raw.coverage.selectedStateFamilies, "terminal row count mismatch");
for (const row of raw.coverage.terminalExactNumberHash.rows) {
  check(row.number === raw.pin.number && row.hash === raw.pin.hash && row.exactMatch === true, "terminal exact pin mismatch");
}
check(raw.coverage.historyCompleteAcrossDiscoveredManagers === true, "history incomplete");
check(raw.deployments.managerCount === 2, "manager count mismatch");
check(raw.deployments.histories.length === 2, "history manager count mismatch");
check(raw.deployments.histories[0].rows.length === 5, "root admission count mismatch");
check(raw.deployments.histories[1].rows.length === 6, "interest admission count mismatch");
for (const history of raw.deployments.histories) {
  check(history.complete === true && history.familyAgreement === true && history.familyCount >= 2, "history agreement absent");
  check(/^\d+$/.test(history.deploymentBlock) && /^[0-9a-f]{64}$/.test(history.digest), "history commitment malformed");
}

const state = raw.deployments.canonicalState;
check(state !== null && state.managers.length === 2, "canonical manager state absent");
check(state.rootManager === raw.deployments.rootPositionManager, "root manager mismatch");
check(state.rToken.address === raw.deployments.rootRToken, "R token mismatch");
check(state.rootRuntime.codeAvailable === true && state.rootRuntime.localSourceRuntimeMatch === null, "root runtime qualification mismatch");
check(state.rToken.runtime.codeAvailable === true && state.rToken.runtime.localSourceRuntimeMatch === null, "R runtime qualification mismatch");
const root = state.managers.find((x) => x.kind === "PositionManager");
const interest = state.managers.find((x) => x.kind === "InterestRatePositionManager");
check(Boolean(root && interest), "manager kinds absent");
check(root.support.redeemCollateral === "nonUnsupportedResult", "root redemption probe mismatch");
check(root.support.threeArgumentAdmission === "nonUnsupportedResult", "root three-argument probe mismatch");
check(root.support.fiveArgumentAdmission === "nonUnsupportedResult", "root five-argument probe mismatch");
check(root.support.scope.includes("manager-level-dispatch-only"), "root support scope absent");
check(interest.support.redeemCollateral === "unsupported", "interest redemption must be unsupported");
check(interest.support.threeArgumentAdmission === "unsupported", "interest three-argument admission mismatch");
check(interest.support.fiveArgumentAdmission === "nonUnsupportedResult", "interest five-argument probe mismatch");
check(interest.support.fiveArgumentSourceSupport === "source-supported-owner-only", "interest five-argument source support absent");
check(interest.support.fiveArgumentDeployedDispatch === null, "interest five-argument deployed dispatch must remain null");
check(root.feeCollectorMode.includes("inherited-in-manager"), "root FeeCollector mode absent");
check(interest.feeCollectorMode.includes("inherited-in-manager"), "interest FeeCollector mode absent");

const rows = raw.collateralSummary.rows;
check(raw.collateralSummary.admittedCount === 11 && rows.length === 11, "collateral count mismatch");
check(raw.collateralSummary.callbackCapableCount === 0, "callback-positive collateral must be zero");
check(raw.collateralSummary.callbackSemanticsUnknownCount === 11, "callback unknown count mismatch");
check(rows.filter((x) => x.info.enabled).length === 4, "enabled count mismatch");
check(rows.filter((x) => !x.info.enabled).length === 7, "disabled count mismatch");
check(rows.filter((x) => x.accounting.debtCap !== null).length === 6, "known debt cap count mismatch");
check(rows.filter((x) => x.accounting.debtCap === null).length === 5, "null debt cap count mismatch");
for (const row of rows) {
  check(/^0x[0-9A-Fa-f]{40}$/.test(row.collateralToken), "collateral address malformed");
  check(row.runtime.codeAvailable === true, "collateral runtime absent");
  check(row.runtime.ordinaryTransferCallbackCapable === null, "callback false must not be overclaimed");
  check(row.runtime.callbackClassification.includes("ARBITRARY-CALL-SEMANTICS-UNPROVEN"), "callback qualification absent");
  check(row.runtimeBindings.collateralClaimToken.codeAvailable === true, "claim runtime absent");
  check(row.runtimeBindings.debtToken.codeAvailable === true, "debt runtime absent");
  check(row.runtimeBindings.priceFeed.codeAvailable === true, "price runtime absent");
  check(row.runtimeBindings.splitLiquidation.codeAvailable === true, "split runtime absent");
  check(row.accounting.lowTotalDebt !== null && row.accounting.mcr !== null, "minimum/MCR absent");
}
check(raw.integrity.admissionEventUniqueCount === 11, "admission uniqueness count mismatch");
check(raw.integrity.eventCurrentTupleIdentityCount === 11, "event/current identity count mismatch");
check(raw.integrity.callbackIndicatorBooleansValidated === true, "callback indicator integrity absent");
check(raw.integrity.feeRecipientEqualityAcrossManagers === true, "fee recipient integrity absent");
check(raw.integrity.capHeadroomNullArithmeticValidated === true, "cap arithmetic integrity absent");
const admissionKeys = new Set();
for (const history of raw.deployments.histories) {
  const manager = state.managers.find((x) => x.manager.toLowerCase() === history.manager.toLowerCase());
  check(Boolean(manager), "history manager absent from state");
  for (const event of history.rows) {
    const key = `${history.manager.toLowerCase()}:${event.collateralToken.toLowerCase()}`;
    check(!admissionKeys.has(key), "duplicate admission event");
    admissionKeys.add(key);
    const current = manager.collateral.find((x) => x.collateralToken.toLowerCase() === event.collateralToken.toLowerCase());
    check(Boolean(current), "admission missing current tuple");
    check(current.info.collateralClaimToken.toLowerCase() === event.raftCollateralToken.toLowerCase(), "claim tuple mismatch");
    check(current.info.debtToken.toLowerCase() === event.raftDebtToken.toLowerCase(), "debt tuple mismatch");
    check(current.info.priceFeed.toLowerCase() === event.priceFeed.toLowerCase(), "price tuple mismatch");
  }
}
check(admissionKeys.size === 11, "unique admission count mismatch");
for (const row of rows) {
  if (row.accounting.debtCap === null || row.accounting.totalDebt === null) {
    check(row.accounting.debtCapHeadroom === null, "null cap/total must produce null headroom");
  } else {
    check(BigInt(row.accounting.debtCapHeadroom) === BigInt(row.accounting.debtCap) - BigInt(row.accounting.totalDebt), "headroom arithmetic mismatch");
  }
}
const indicatorKeys = ["erc1820Registry", "tokensReceivedSelector", "erc1363ReceiverSelector", "erc223ReceiverSelector", "erc677ReceiverSelector", "transferAndCallSelector"];
const profiles = [state.rootRuntime, state.rToken.runtime, state.feeRecipient.runtime];
for (const manager of state.managers) {
  profiles.push(manager.runtime);
  for (const row of manager.collateral) profiles.push(row.runtime, ...Object.values(row.runtimeBindings));
}
for (const profile of profiles) for (const key of indicatorKeys) check(typeof profile.callbackIndicators[key] === "boolean", `callback indicator non-boolean: ${key}`);
check(new Set(state.managers.map((x) => x.feeRecipient.toLowerCase())).size === 1, "manager fee recipients differ");
check(raw.route.currentRouteExistence === null, "route existence must remain null");
check(raw.route.callbackCapableAdmittedCollateralEstablished === null, "callback exposure must remain null");
check(raw.route.establishedCallbackPositiveCount === 0, "established callback count mismatch");
check(raw.route.currentEvidenceGap === "callback-exposure-unestablished", "current evidence gap mismatch");
check(raw.route.operationalRoutePositiveInterpretation.includes("does not prove route absence"), "operational gate qualification absent");
check(raw.route.rootManagerSupportScope.includes("lock-gated"), "lock-gated root scope absent");
check(raw.route.branchAndHeadroomAnalysisReached === false && raw.route.gasEstimate === null && raw.route.economics === null, "unreached economics must be null");
check(raw.route.forkGate.includes("closed"), "fork gate not closed");
check(raw.feeRecipientAssessment.address === state.feeRecipient.address, "fee recipient mismatch");
check(raw.feeRecipientAssessment.runtime.codeSize === 170, "fee runtime size mismatch");
check(raw.feeRecipientAssessment.privateIdentityAssessment === null, "private identity must remain null");

check(raw.authorization.stateChangingOperations === 0 && raw.authorization.liveExploitCalls === 0, "live operation counter nonzero");
check(raw.authorization.graphqlInventoryUsed === false, "GraphQL should be unused");
check(raw.offlineCorrectionActivity.newInventoryReads === 0 && raw.offlineCorrectionActivity.newRpcRequests === 0, "offline correction used RPC/inventory");
check(raw.purity.liveTransactions === 0 && raw.purity.signedActions === 0 && raw.purity.forks === 0 && raw.purity.secretReads === 0, "purity counter nonzero");
for (const key of ["rawEndpointUrlsStored", "endpointDomainsStored", "providerNamesStored", "credentialsStored", "headersStored", "rawResponsesStored", "privateIdentitiesStored"]) {
  check(raw.purity[key] === 0, `leak counter nonzero: ${key}`);
}
check(raw.purity.networkRequests === null, "unknown total request count must remain null");
check(raw.purity.endpointInventoryReads === 1, "endpoint inventory read count mismatch");
check(raw.purity.networkRequestsKnownLowerBound === 9108 && raw.purity.networkRequestsUpperBound === 15108, "request bounds mismatch");
check(raw.purity.priorKnownCaptureNetworkRequestsProvenance.includes("not-transcript-bound"), "prior request provenance absent");
check(raw.purity.priorLeakGuardCaptureProvenance.includes("not-transcript-bound"), "rejected capture provenance absent");
check(raw.purity.leakGuard === "PASS", "capture leak guard absent");

check(summary.gates.currentRouteExistence === null && summary.gates.operationalRoutePositive === 0, "summary route gates mismatch");
check(summary.deployment.countProvenance.includes("manual-workspace-observation"), "deployment count provenance absent");
check(summary.captureProvenance.endpointInventoryReads === 1, "summary inventory count mismatch");
check(summary.captureProvenance.priorKnownRequestAssertionTranscriptBound === false, "summary prior provenance mismatch");
check(summary.offlineCorrectionActivity.newNetworkRequests === 0, "summary correction network nonzero");
check(summary.support.interestRatePositionManager.fiveArgumentDeployedDispatch === null, "summary five-argument dispatch mismatch");
check(summary.callback.erc223OrdinaryTransferClassifiedCallbackCapable === true, "summary ERC223 classification absent");

const generatedTexts = [read(RAW), read(SUMMARY), report, read(INBOX), handoff];
for (const text of generatedTexts) {
  check(!/https?:\/\//i.test(text), "endpoint/URL material persisted");
  check(!/[a-z0-9-]+\.(?:com|io|org|net|xyz|app|pro|dev)(?:[\/:"\\]|$)/i.test(text), "domain material persisted");
  check(!/Bearer\s/i.test(text), "header/token material persisted");
}
check(!runner.includes("PUBLIC_FALLBACK"), "runner must not embed endpoint fallback inventory");
check(runner.includes("leakGuard(output);"), "pre-write leak guard absent");
check(runner.includes("urls.fill(\"\");"), "in-memory URL clearing absent");
check(runner.includes(': "nonUnsupportedResult";'), "absent-selector support classification absent");
check(runner.includes("CALLBACK-CAPABLE-ERC223-ORDINARY-TRANSFER-RUNTIME-INDICATOR"), "ERC223 ordinary-transfer classification absent");
check(tester.includes("domain rejected") && tester.includes("URL rejected") && tester.includes("bearer header rejected"), "leak fixtures absent");
check(tester.includes("duplicate admission rejected") && tester.includes("event/current tuple mismatch rejected"), "admission fixtures absent");
check(tester.includes("ERC223 ordinary transfer classified callback-capable"), "ERC223 fixture absent");
check(tester.includes("empty revert remains unknown"), "absent-selector fixture absent");
check(tester.includes("fee recipient mismatch rejected"), "fee recipient fixture absent");
check(tests.trim() === "PASS 41 offline fixture checks", "offline fixture transcript mismatch");

check(positionManager.includes("collateralToken.safeTransfer(feeRecipient, redemptionFee - rebate);"), "fee transfer source absent");
check(positionManager.includes("collateralToken.safeTransfer(msg.sender, collateralToRedeem - redemptionFee);"), "caller transfer source absent");
check(positionManager.includes("collateralToken.safeTransfer(feeRecipient, collateralLiquidationFee);"), "zero-fee liquidation transfer source absent");
check(interestManager.includes("function redeemCollateral(IERC20, uint256, uint256)"), "interest redemption override absent");
check(interestManager.includes("function addCollateralToken("), "interest admission override absent");
check(erc20RMinter.includes("abstract contract ERC20RMinter is IRMinter, ERC20, Ownable2Step"), "ordinary ERC20 minter source absent");
check(basePSM.includes("abstract contract BasePSM is IPSM, ERC20RMinter"), "PSM ERC20 minter source absent");
check(wrapped.includes("super._transfer(from, to, amount);"), "wrapper ordinary transfer source absent");
check(split.includes("collateralToSendToProtocol = 0;"), "zero liquidation fee source absent");
check(priceFeed.includes("function fetchPrice() external override returns"), "price path source absent");
check(wbtcTest.includes("irPosman.addCollateralToken("), "WBTC five-argument fixture absent");

check(report.includes("11 historically admitted collateral rows"), "report admitted count absent");
check(report.includes("callback exposure **unestablished**"), "report callback qualification absent");
check(report.includes("all 11 rows retain exact callback semantics as null rather than false"), "null callback wording absent");
check(report.includes("Total request count therefore remains null"), "request-count qualification absent");
check(report.includes("No broader supported-chain or L2 deployment-completeness claim is made"), "chain coverage caveat absent");
check(report.includes("Operational zero is evidence-gated and does not assert route absence"), "operational gate wording absent");
check(report.includes("prior-run assertions not independently transcript-bound"), "prior-run provenance wording absent");
check(report.includes("manager-level only"), "manager-level support qualification absent");

check(Array.isArray(manifest.files) && manifest.files.length >= 20, "manifest incomplete");
for (const row of manifest.files) check(sha256(row.path) === row.sha256, `manifest hash mismatch: ${row.path}`);
const preimage = manifest.files.map((row) => `${row.sha256}  ${row.path}`).join("\n") + "\n";
const aggregate = crypto.createHash("sha256").update(preimage).digest("hex");
check(aggregate === manifest.aggregateSha256, "manifest aggregate mismatch");
check(manifest.aggregatePreimageFormat === "<sha256><two spaces><path><LF>", "aggregate format mismatch");
for (const row of manifest.files.filter((x) => /\.(js|json|md|sol|txt)$/.test(x.path))) {
  const text = read(row.path);
  check(text.endsWith("\n"), `missing final newline: ${row.path}`);
  check(!/[ \t]+$/m.test(text), `trailing whitespace: ${row.path}`);
}

console.log(`PASS ${checks} checks; aggregate ${aggregate}`);
