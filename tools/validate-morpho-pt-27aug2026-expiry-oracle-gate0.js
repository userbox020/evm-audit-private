#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NS = "morpho-pt-27aug2026-expiry-oracle-gate0";
const DIR = path.join(ROOT, "reports", "raw", "fast", NS);
const FILES = {
  capture: path.join(DIR, "capture.json"), inputs: path.join(DIR, "verified-compiler-inputs.json"),
  source: path.join(DIR, "source-runtime-manifest.json"), correction: path.join(DIR, "correction-manifest.json"),
  tests: path.join(DIR, "test-results.json"), idempotence: path.join(DIR, "correction-idempotence-results.json"),
  report: path.join(ROOT, "reports", `critical-${NS}.md`),
  inbox: path.join(ROOT, "coordination", "inbox", "critical", "20260822-0645-implementation-morpho-pt-27aug2026-expiry-oracle-gate0-terminal.json"),
  handoff: path.join(ROOT, "coordination", "handoffs", "20260822-0645-implementation-morpho-pt-27aug2026-expiry-oracle-gate0-terminal.md"),
  captureTool: path.join(ROOT, "tools", `capture-${NS}.js`), correctionTool: path.join(ROOT, "tools", `correct-${NS}.js`),
  testTool: path.join(ROOT, "tools", `test-${NS}.js`),
  idempotenceTool: path.join(ROOT, "tools", `test-correct-${NS}-idempotence.js`),
  validatorTool: __filename
};
const OUT = path.join(DIR, "validation.json");
const sha256 = (bytes) => `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
let checks = 0;
function check(value, label) { checks++; if (!value) throw new Error(`CHECK_FAILED:${label}`); }
function bytes(name) { const value = fs.readFileSync(FILES[name]); check(value.length > 0, `${name}-nonempty`); return value; }
function json(name) { return JSON.parse(bytes(name).toString("utf8")); }

function main() {
  check(process.argv.length === 2, "argv");
  const capture = json("capture"), inputs = json("inputs"), source = json("source"), correction = json("correction"),
    tests = json("tests"), idempotence = json("idempotence"), inbox = json("inbox");
  const report = bytes("report").toString("utf8"), handoff = bytes("handoff").toString("utf8");
  const captureBytes = fs.readFileSync(FILES.capture), inputBytes = fs.readFileSync(FILES.inputs), sourceBytes = fs.readFileSync(FILES.source),
    correctionBytes = fs.readFileSync(FILES.correction);
  check(capture.schema === `${NS}/capture-v2-oracle-review-correction`, "capture-schema");
  check(inputs.schema === `${NS}/explorer-candidate-compiler-bundles-v2`, "inputs-schema");
  check(source.schema === `${NS}/source-runtime-manifest-v2-candidate-closure`, "source-schema");
  check(correction.schema === `${NS}/oracle-review-correction-manifest-v2-rerun-safe`, "correction-schema");
  check(tests.schema === `${NS}/test-results-v2-oracle-review-correction`, "tests-schema");
  check(capture.status === "STOP_SOURCE_RUNTIME_GAP", "status");
  check(capture.chain.chainId === "1" && capture.chain.finalizedBlock.number === "25808855", "pin-number");
  check(capture.chain.finalizedBlock.hash === "0x0ea4b5b3ef029ab6f6ec996a718004f96a6dd0b38287d1db6b92edca2b824208", "pin-hash");
  check(capture.chain.finalizedBlock.stateRoot === "0x81ef5cb4564e6374f2169f499755b75a5c0e503191664d02be7db6eebd288cdf", "state-root");
  check(capture.chain.statePin.blockHash === capture.chain.finalizedBlock.hash && capture.chain.statePin.requireCanonical === true, "eip1898");
  check(capture.chain.twoDistinctHostnameFamiliesAgreedUnderCaptureHeuristic === true
    && capture.chain.infrastructureIndependenceProven === false && capture.chain.terminalRecheckExact === true, "hostname-families");
  check(capture.qualification.selectedDistinctHostnameFamilies === 2
    && capture.qualification.familyHeuristic.includes("do not prove independent infrastructure")
    && capture.qualification.infrastructureIndependenceProven === false, "provider-caveat");
  check(capture.rows.length === 3 && capture.rows.every((row) => row.marketIdVerified === true), "market-ids");
  const supply = capture.rows.reduce((sum, row) => sum + BigInt(row.marketState.totalSupplyAssets), 0n);
  const activeSupply = capture.rows.slice(0, 2).reduce((sum, row) => sum + BigInt(row.marketState.totalSupplyAssets), 0n);
  const borrow = capture.rows.reduce((sum, row) => sum + BigInt(row.marketState.totalBorrowAssets), 0n);
  check(activeSupply === 2617552752545n && supply === 2617552753545n && borrow === 2382684073594n, "material-sums");
  check(capture.materiality.activeTwoMarketStoredSupplyAssetsRawUsdc === activeSupply.toString()
    && capture.materiality.allThreeStoredSupplyAssetsRawUsdc === supply.toString()
    && capture.materiality.allThreeStoredBorrowAssetsRawUsdc === borrow.toString(), "material-raw-fields");
  check(capture.materiality.activeTwoMarketStoredSupplyUsdc === "2617552.752545"
    && capture.materiality.allThreeStoredSupplyUsdc === "2617552.753545"
    && capture.materiality.allThreeStoredBorrowUsdc === "2382684.073594", "material-decimal-fields");
  check(capture.materiality.storedUnaccruedAtMorphoMarketState === true
    && capture.materiality.subtractionMeaning.includes("not independently measured available liquidity"), "material-semantics");
  check(capture.rows.every((row) => BigInt(row.storedSupplyMinusStoredBorrowAssets)
    === BigInt(row.marketState.totalSupplyAssets) - BigInt(row.marketState.totalBorrowAssets)
    && row.marketStateSemantics.includes("Stored/unaccrued") && !Object.hasOwn(row, "availableLiquidityAssets")), "stored-subtraction-identities");
  check(capture.rows.every((row) => row.oracleFormula.exact === true && row.linearDiscount.wrapperAnswerExact === true), "formula-exact-at-pin");
  check(capture.oracleSemantics.twapDuration === "n/a" && capture.oracleSemantics.cardinality === "n/a", "no-twap");
  check(capture.formulaAssessment.mode === "MODELED_NOT_OBSERVED_AT_EXPIRY"
    && capture.formulaAssessment.admittedFormulaExtraExpiryDiscontinuity === false
    && capture.formulaAssessment.deployedEndToEndExpiryBehavior === "unknown"
    && capture.formulaAssessment.modeledPtLegLastStepWei === "6341958396"
    && capture.formulaAssessment.modeledPtLegLastStepPar === "0.000000006341958396", "formula-model-deployed-split");
  check(capture.oracleSemantics.apxUsdFeedAtPin.ageSeconds === "43320"
    && capture.oracleSemantics.fixedQuoteDiscount.startsWith("approximately 2.5%"), "feed-age-quote-caveat");
  check(source.gaps.length === 6 && capture.sourceRuntime.gaps.length === 6, "six-gaps");
  check(source.gaps.every((row) => row.blocker === "EXPLORER_PARTIAL_NOT_EXACT"), "gap-reasons");
  const partialAddresses = new Set([
    "0x130e1c3c755588ccfa08482ce8066c0d94676efe", "0xbdf49b12043906b646e4faee7413ca61f2262aec",
    "0x30bb9ee8dc6aab322dc3a0d36063cbf06a9e5952", "0xc3e6cc9269dc780e0d55512c46cad1dd29cfbaa5",
    "0x446e404b52c1db5c99e1bda5ee80d73c10dffe90", "0xbd9d4e9ac505ed2cbf62ecfd7a24b7d4a798f6dd"
  ]);
  check(source.gaps.every((row) => partialAddresses.has(row.address))
    && [...partialAddresses].every((address) => source.gaps.some((row) => row.address === address)), "exact-gap-addresses");
  check(source.contracts.filter((row) => row.bundleAuthority === "EXPLORER_CANDIDATE_PARTIAL_NOT_EXACT").length === 6
    && source.contracts.filter((row) => partialAddresses.has(row.address)).every((row) => row.exactVerifiedSourceRuntime === false
      && row.explorerRuntimeEqualityNotSufficient === true), "source-candidate-authority");
  check(inputs.contracts.length >= 20 && inputs.contracts.every((row) => row.sources && Object.keys(row.sources).length > 0), "compiler-inputs");
  check(inputs.classification.includes("CANDIDATE_COMPILER_BUNDLES")
    && inputs.contracts.filter((row) => row.bundleAuthority === "EXPLORER_CANDIDATE_PARTIAL_NOT_EXACT").length === 6, "input-candidate-authority");
  check(inputs.contracts.find((row) => row.address === "0x30bb9ee8dc6aab322dc3a0d36063cbf06a9e5952")?.constructorArgsStatus === "MISSING_CANDIDATE", "missing-constructor-args");
  const classes = source.dependencyClosure;
  check(Object.keys(classes).length === 4 && JSON.stringify(classes) === JSON.stringify(capture.sourceRuntime.dependencyClosure), "four-dependency-classes");
  check(classes.oracleFormulaDependencies.status === "BLOCKED_WRAPPER_EXACT_BINDING"
    && classes.oracleFormulaDependencies.pendleMarketsRequired === false
    && classes.oracleFormulaDependencies.syImplementationsRequired === false, "oracle-dependency-class");
  check(classes.ptYtSyRedemptionDependencies.status === "BLOCKED_SY_IMPLEMENTATION_AND_TOPOLOGY"
    && classes.ptYtSyRedemptionDependencies.pendleMarketsRequired === false, "redemption-dependency-class");
  check(classes.morphoLiquidationProtocolLossDependencies.status === "BLOCKED_MORPHO_CORE_USDC_AND_ORACLE_CLOSURE", "morpho-loss-dependency-class");
  check(classes.routeSpecificExitDependencies.status === "NOT_OPENED_NO_ROUTE"
    && classes.routeSpecificExitDependencies.pendleMarketExit.requiredOnlyIfSelected === true, "exit-dependency-class");
  check(source.authority.broadRouteClosure.includes("neither necessary nor sufficient")
    && source.constructorArguments.missingCandidateBundles.length === 1, "source-authority-caveats");
  check(correction.status === "PASS_OFFLINE_CORRECTION" && correction.safety.offline === true
    && correction.safety.network === false && correction.safety.rpc === false, "correction-offline");
  check(correction.rerunSafety.stateMachine.correctedMatch === "ALREADY_CORRECTED_ZERO_WRITES"
    && correction.rerunSafety.stateMachine.parentMatch === "APPLY_EXACTLY_ONCE"
    && correction.rerunSafety.stateMachine.neitherMatch === "FAIL_BEFORE_ANY_WRITE"
    && correction.rerunSafety.checkCommand === `node tools\\correct-${NS}.js --check`, "correction-rerun-safety");
  check(correction.parent.capture.sha256 === "0xd272347936ad9a6aff23a0f617a52324abf5dbb1f294e1712cc4527c4d0a0856"
    && correction.parent.inputs.sha256 === "0xbfcaac389a8636779c3a06d2b2a326e9212a57151cb3efd7bbe461e680e74776"
    && correction.parent.source.sha256 === "0x8481da3068646482b4080199695844e0534a97c52eddb911ea3e55e9ba37e704", "parent-commitments");
  check(correction.corrected.capture.sha256 === sha256(captureBytes) && correction.corrected.capture.bytes === captureBytes.length
    && correction.corrected.inputs.sha256 === sha256(inputBytes) && correction.corrected.inputs.bytes === inputBytes.length
    && correction.corrected.source.sha256 === sha256(sourceBytes) && correction.corrected.source.bytes === sourceBytes.length, "corrected-commitments");
  check(capture.correction.parentCaptureSha256 === correction.parent.capture.sha256 && source.correction.parentSha256 === correction.parent.source.sha256
    && inputs.correction.parentSha256 === correction.parent.inputs.sha256, "embedded-parent-lineage");
  check(correction.terminal.status === capture.status && correction.terminal.material === true && correction.terminal.finding === false
    && correction.terminal.protocolAccountingFlaw === "unknown" && correction.terminal.deployedEndToEndExpiryBehavior === "unknown"
    && correction.terminal.economics === "N/A_UNOPENED", "correction-terminal");
  check(tests.status === "PASS" && tests.assertions === 16424
    && tests.result.mode === "MODELED_NOT_OBSERVED_AT_EXPIRY"
    && tests.result.admittedFormulaExtraExpiryDiscontinuity === false
    && tests.result.deployedEndToEndExpiryBehavior === "unknown"
    && tests.result.modeledPtLegLastStepWei === "6341958396"
    && tests.result.dependencyClassesAsserted === 4 && tests.result.partialCandidateBundles === 6, "tests");
  check(tests.inputs.capture.sha256 === sha256(captureBytes) && tests.inputs.compilerInputs.sha256 === sha256(inputBytes)
    && tests.inputs.sourceRuntimeManifest.sha256 === sha256(sourceBytes)
    && tests.inputs.correctionManifest.sha256 === sha256(correctionBytes), "test-input-hashes");
  check(idempotence.schema === `${NS}/correction-idempotence-results-v1`
    && idempotence.status === "PASS" && idempotence.assertions === 53, "idempotence-summary");
  check(idempotence.checkMode.status === "ALREADY_CORRECTED" && idempotence.checkMode.writes === 0
    && idempotence.firstRun.status === "ALREADY_CORRECTED" && idempotence.firstRun.writes === 0
    && idempotence.secondRun.status === "ALREADY_CORRECTED" && idempotence.secondRun.writes === 0, "idempotence-runs");
  check(idempotence.byteIdenticalArtifacts.length === 4
    && ["capture", "inputs", "source", "correction"].every((name) => idempotence.byteIdenticalArtifacts.includes(name))
    && idempotence.invariants.storedSubtractionFieldsPresent === 3
    && idempotence.invariants.storedSubtractionFieldsExact === 3
    && idempotence.invariants.hostnameFamilyAgreement === true
    && idempotence.stateMachineCases.corrected === "ALREADY_CORRECTED"
    && idempotence.stateMachineCases.parent === "PARENT_READY"
    && idempotence.stateMachineCases.neither === "MISMATCH", "idempotence-invariants");
  check(idempotence.commitments.capture.sha256 === sha256(captureBytes)
    && idempotence.commitments.inputs.sha256 === sha256(inputBytes)
    && idempotence.commitments.source.sha256 === sha256(sourceBytes)
    && idempotence.commitments.correction.sha256 === sha256(correctionBytes), "idempotence-commitments");
  check(idempotence.safety.offline === true && idempotence.safety.network === false && idempotence.safety.rpc === false
    && idempotence.safety.transaction === false && idempotence.safety.signing === false && idempotence.safety.broadcast === false, "idempotence-safety");
  check(capture.gates.routePositive === "unknown" && capture.gates.executableNow === "unknown", "capture-gates");
  check(inbox.routePositive === "unknown" && inbox.executableNow === "unknown" && inbox.routeDisposition === "UNKNOWN", "inbox-gates");
  check(inbox.finding === false && inbox.material === true && inbox.protocolAccountingFlaw === "unknown"
    && inbox.deployedEndToEndExpiryBehavior === "unknown", "inbox-terminal");
  check(inbox.tests.assertions === 16424 && inbox.tests.mode === "MODELED_NOT_OBSERVED_AT_EXPIRY"
    && inbox.tests.admittedFormulaExtraExpiryDiscontinuity === false && inbox.tests.modeledPtLegLastStepWei === "6341958396", "inbox-tests");
  check(inbox.materiality.activeTwoMarketStoredSupplyUsdc === "2617552.752545"
    && inbox.materiality.allThreeStoredSupplyUsdc === "2617552.753545"
    && inbox.materiality.allThreeStoredBorrowUsdc === "2382684.073594", "inbox-materiality");
  check(inbox.providerQualification.distinctHostnameFamiliesUnderHeuristic === 2
    && inbox.providerQualification.independentInfrastructureProven === false, "inbox-provider-caveat");
  check(inbox.dependencyClosure.oracleFormulaDependencies === classes.oracleFormulaDependencies.status
    && inbox.dependencyClosure.ptYtSyRedemptionDependencies === classes.ptYtSyRedemptionDependencies.status
    && inbox.dependencyClosure.morphoLiquidationProtocolLossDependencies === classes.morphoLiquidationProtocolLossDependencies.status
    && inbox.dependencyClosure.routeSpecificExitDependencies === classes.routeSpecificExitDependencies.status
    && inbox.dependencyClosure.pendleMarketsRequiredOnlyForMarketExit === true, "inbox-dependencies");
  check(inbox.economics.status === "N/A" && inbox.economics.result === "n/a", "inbox-economics");
  check(inbox.correctionSafety.safeCheckCommand === `node tools\\correct-${NS}.js --check`
    && inbox.correctionSafety.secondRunStatus === "ALREADY_CORRECTED" && inbox.correctionSafety.secondRunWrites === 0
    && inbox.correctionSafety.idempotenceAssertions === 53 && inbox.correctionSafety.byteIdenticalArtifacts === 4, "inbox-correction-safety");
  check(capture.gates.signedActionJustified === false && inbox.signedActionJustified === false && capture.gates.fork.justified === false, "safety-gates");
  check(report.includes("SIGNAL: TERMINAL FAIL-CLOSED") && report.includes(capture.chain.finalizedBlock.hash)
    && report.includes('admittedFormulaExtraExpiryDiscontinuity=false')
    && report.includes('deployedEndToEndExpiryBehavior="unknown"')
    && report.includes("6,341,958,396") && report.includes("16,424")
    && report.includes(`node tools\\correct-${NS}.js --check`) && report.includes("ALREADY_CORRECTED")
    && report.includes('routePositive: "unknown"') && report.includes('executableNow: "unknown"'), "report-binding");
  check(report.includes("2,617,552.752545") && report.includes("2,617,552.753545") && report.includes("2,382,684.073594")
    && report.includes("not independently measured available liquidity"), "report-materiality");
  check(report.includes("distinct hostname families under the capture heuristic") && report.includes("does not prove independent infrastructure")
    && report.includes("candidate compiler bundles") && report.includes("lacks constructor arguments"), "report-caveats");
  check(handoff.includes(capture.chain.finalizedBlock.hash) && handoff.includes("16,424")
    && handoff.includes('admittedFormulaExtraExpiryDiscontinuity=false')
    && handoff.includes('deployedEndToEndExpiryBehavior="unknown"')
    && handoff.includes("does not prove independent infrastructure")
    && handoff.includes(`node tools\\correct-${NS}.js --check`) && handoff.includes("ALREADY_CORRECTED"), "handoff-binding");
  check(inbox.validation.status === "PASS" && inbox.validation.checks === 87
    && inbox.validation.schema === `${NS}/validation-v2-oracle-review-correction`
    && report.includes("**PASS**, `87` checks") && handoff.includes("PASS, `87` checks"), "terminal-validator-count");
  check(!report.includes("two independently qualified") && !handoff.includes("two independently qualified")
    && !report.includes("16,407") && !handoff.includes("16,407"), "stale-wording-absent");
  for (const field of ["endpointOrCredentialPersisted", "endpointMaterialHashed", "rawRpcPersisted", "rpcOnArgv", "environmentFilesRead",
    "keyFilesRead", "transaction", "signing", "broadcast", "fork", "productionMutation", "victimTargeting", "feedManipulation"])
    check(capture.safety[field] === false, `safety-${field}`);
  const artifacts = {};
  for (const [name, file] of Object.entries(FILES)) { const value = fs.readFileSync(file); artifacts[name] = { path: path.relative(ROOT, file).replaceAll("\\", "/"), bytes: value.length, sha256: sha256(value) }; }
  const output = { schema: `${NS}/validation-v2-oracle-review-correction`, generatedAt: new Date().toISOString(), status: "PASS", checks,
    pin: { chainId: "1", blockNumber: capture.chain.finalizedBlock.number, blockHash: capture.chain.finalizedBlock.hash, stateRoot: capture.chain.finalizedBlock.stateRoot },
    conclusion: { status: capture.status, materialState: true, finding: false,
      admittedFormulaExtraExpiryDiscontinuity: false, deployedEndToEndExpiryBehavior: "unknown", modeledPtLegLastStepWei: "6341958396",
      protocolAccountingFlaw: "unknown", dependencyClasses: 4, partialCandidateBundles: 6, sourceRuntimeGaps: 6,
      routePositive: "unknown", executableNow: "unknown", forkJustified: false, economics: "N/A_UNOPENED" },
    materiality: { activeTwoMarketStoredSupplyAssetsRawUsdc: activeSupply.toString(), allThreeStoredSupplyAssetsRawUsdc: supply.toString(),
      allThreeStoredBorrowAssetsRawUsdc: borrow.toString(), semantics: "stored/unaccrued; subtraction is not independently measured liquidity" },
    providerQualification: { distinctHostnameFamiliesUnderHeuristic: 2, infrastructureIndependenceProven: false },
    correctionLineage: { parent: correction.parent, corrected: correction.corrected, correctionManifestSha256: sha256(correctionBytes) },
    rerunSafety: { safeCheckCommand: correction.rerunSafety.checkCommand, secondRunStatus: idempotence.secondRun.status,
      secondRunWrites: idempotence.secondRun.writes, idempotenceAssertions: idempotence.assertions,
      byteIdenticalArtifacts: idempotence.byteIdenticalArtifacts.length },
    commands: [
      "node tools\\test-morpho-pt-27aug2026-expiry-oracle-gate0.js",
      "node tools\\correct-morpho-pt-27aug2026-expiry-oracle-gate0.js --check",
      "node tools\\correct-morpho-pt-27aug2026-expiry-oracle-gate0.js",
      "node tools\\test-correct-morpho-pt-27aug2026-expiry-oracle-gate0-idempotence.js",
      "node tools\\validate-morpho-pt-27aug2026-expiry-oracle-gate0.js"
    ], artifacts, safety: { offlineValidator: true, inventoryRead: false, network: false, envRead: false, keyRead: false,
      fork: false, transaction: false, signing: false, broadcast: false, productionMutation: false } };
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ status: output.status, checks, dependencyClasses: 4, sourceRuntimeGaps: 6,
    admittedFormulaExtraExpiryDiscontinuity: false, deployedEndToEndExpiryBehavior: "unknown", routePositive: "unknown", fork: false }));
}

try { main(); } catch (error) { console.error(JSON.stringify({ status: "FAIL", diagnostic: String(error.message || error).slice(0, 300) })); process.exitCode = 1; }
