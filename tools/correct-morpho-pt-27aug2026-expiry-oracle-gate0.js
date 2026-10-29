#!/usr/bin/env node
"use strict";

// Offline Oracle-review correction overlay. This script consumes only existing
// branch artifacts and performs no network, RPC, inventory, environment, key,
// fork, transaction, signing, or production action.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NS = "morpho-pt-27aug2026-expiry-oracle-gate0";
const DIR = path.join(ROOT, "reports", "raw", "fast", NS);
const PATHS = {
  capture: path.join(DIR, "capture.json"),
  inputs: path.join(DIR, "verified-compiler-inputs.json"),
  source: path.join(DIR, "source-runtime-manifest.json"),
  correction: path.join(DIR, "correction-manifest.json")
};
const EXPECTED_PARENT = Object.freeze({
  capture: { sha256: "0xd272347936ad9a6aff23a0f617a52324abf5dbb1f294e1712cc4527c4d0a0856", bytes: 38159 },
  inputs: { sha256: "0xbfcaac389a8636779c3a06d2b2a326e9212a57151cb3efd7bbe461e680e74776", bytes: 1798382 },
  source: { sha256: "0x8481da3068646482b4080199695844e0534a97c52eddb911ea3e55e9ba37e704", bytes: 85957 }
});
const PARTIAL = new Set([
  "0x130e1c3c755588ccfa08482ce8066c0d94676efe", "0xbdf49b12043906b646e4faee7413ca61f2262aec",
  "0x30bb9ee8dc6aab322dc3a0d36063cbf06a9e5952", "0xc3e6cc9269dc780e0d55512c46cad1dd29cfbaa5",
  "0x446e404b52c1db5c99e1bda5ee80d73c10dffe90", "0xbd9d4e9ac505ed2cbf62ecfd7a24b7d4a798f6dd"
]);
const WRAPPERS = ["0x130e1c3c755588ccfa08482ce8066c0d94676efe", "0xbdf49b12043906b646e4faee7413ca61f2262aec"];
const MARKETS = ["0xc3e6cc9269dc780e0d55512c46cad1dd29cfbaa5", "0x30bb9ee8dc6aab322dc3a0d36063cbf06a9e5952"];
const SY_IMPLEMENTATIONS = ["0xbd9d4e9ac505ed2cbf62ecfd7a24b7d4a798f6dd", "0x446e404b52c1db5c99e1bda5ee80d73c10dffe90"];
const sha256 = (bytes) => `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const read = (file) => fs.readFileSync(file);
const json = (file) => JSON.parse(read(file).toString("utf8"));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const record = (bytes) => ({ sha256: sha256(bytes), bytes: bytes.length });
const sameRecord = (left, right) => Boolean(left && right && left.sha256 === right.sha256 && left.bytes === right.bytes);
const sameCommitments = (left, right) => ["capture", "inputs", "source"].every((name) => sameRecord(left[name], right[name]));
function classifyCommitments(current, existingManifest = null) {
  if (existingManifest && sameCommitments(current, existingManifest.corrected)) return "ALREADY_CORRECTED";
  if (sameCommitments(current, existingManifest?.parent || EXPECTED_PARENT)) return "PARENT_READY";
  return "MISMATCH";
}
function currentBytesAndCommitments() {
  const bytes = { capture: read(PATHS.capture), inputs: read(PATHS.inputs), source: read(PATHS.source) };
  return { bytes, commitments: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, record(value)])) };
}
function serialized(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function validateExistingManifest(manifest) {
  if (manifest.schema !== `${NS}/oracle-review-correction-manifest-v2-rerun-safe`
    || manifest.status !== "PASS_OFFLINE_CORRECTION" || !sameCommitments(manifest.parent, EXPECTED_PARENT)
    || !manifest.corrected || typeof manifest.correctedAt !== "string") throw new Error("INVALID_EXISTING_CORRECTION_MANIFEST");
  for (const name of ["capture", "inputs", "source"]) if (!/^0x[0-9a-f]{64}$/.test(manifest.corrected[name]?.sha256 || "")
    || !Number.isSafeInteger(manifest.corrected[name]?.bytes) || manifest.corrected[name].bytes <= 0) throw new Error(`INVALID_CORRECTED_COMMITMENT:${name}`);
}
function rerunSafety() {
  return {
    stateMachine: {
      correctedMatch: "ALREADY_CORRECTED_ZERO_WRITES",
      parentMatch: "APPLY_EXACTLY_ONCE",
      neitherMatch: "FAIL_BEFORE_ANY_WRITE"
    },
    checkCommand: `node tools\\correct-${NS}.js --check`,
    correctedCommitmentScope: ["capture.json", "verified-compiler-inputs.json", "source-runtime-manifest.json"],
    idempotenceBytePreservationScope: ["capture.json", "verified-compiler-inputs.json", "source-runtime-manifest.json", "correction-manifest.json"]
  };
}

function dependencyClosure() {
  return {
    oracleFormulaDependencies: {
      purpose: "Strict deployed Morpho oracle formula, including timestamp wrapper and frozen-input expiry model.",
      status: "BLOCKED_WRAPPER_EXACT_BINDING",
      blockers: WRAPPERS,
      pendleMarketsRequired: false,
      syImplementationsRequired: false,
      conclusion: "Inner linear formula is modeled; partial wrapper candidate bundles block strict deployed end-to-end oracle-formula admission."
    },
    ptYtSyRedemptionDependencies: {
      purpose: "PT/YT burn, SY output, and conversion/redemption to the underlying asset.",
      status: "BLOCKED_SY_IMPLEMENTATION_AND_TOPOLOGY",
      blockers: SY_IMPLEMENTATIONS,
      requiredOnReopen: ["SY adapter", "yieldToken", "asset", "pause state", "owner/roles", "underlying implementation", "redemption topology"],
      pendleMarketsRequired: false,
      conclusion: "PT/YT candidate source is insufficient to establish end-to-end redemption while SY implementations and topology remain unbound."
    },
    morphoLiquidationProtocolLossDependencies: {
      purpose: "Morpho health, accrual, liquidation, bad-debt, transfer, and protocol/incumbent-loss semantics.",
      status: "BLOCKED_MORPHO_CORE_USDC_AND_ORACLE_CLOSURE",
      requiredOnReopen: ["Morpho core exact source/runtime", "USDC proxy and implementation semantics", "strict deployed oracle formula", "redemption closure"],
      conclusion: "Captured market getters do not bind Morpho liquidation/protocol-loss semantics or USDC behavior."
    },
    routeSpecificExitDependencies: {
      purpose: "Acquisition and unwind for a concrete public route.",
      status: "NOT_OPENED_NO_ROUTE",
      pendleMarketExit: { requiredOnlyIfSelected: true, candidateBundleBlockers: MARKETS },
      alternativeExit: "Bind the exact selected venue and token path instead of Pendle market contracts.",
      conclusion: "Pendle markets are conditional exit dependencies, not oracle-formula dependencies and not necessary/sufficient for broad route closure."
    }
  };
}

function correctCapture(capture, parentCommitment, correctedAt) {
  capture.schema = `${NS}/capture-v2-oracle-review-correction`;
  capture.correction = { kind: "OFFLINE_SEMANTIC_CORRECTION", correctedAt, parentCaptureSha256: parentCommitment,
    networkOrRpcUsed: false, fixedPinAndRawObservationsChanged: false };
  capture.chain.twoDistinctHostnameFamiliesAgreedUnderCaptureHeuristic = capture.chain.twoIndependentAnonymousFamiliesAgreed === true;
  capture.chain.infrastructureIndependenceProven = false;
  delete capture.chain.twoIndependentAnonymousFamiliesAgreed;
  capture.qualification.selectedDistinctHostnameFamilies = capture.qualification.selectedIndependentFamilies;
  capture.qualification.familyHeuristic = "registrable-hostname-family heuristic only; distinct labels do not prove independent infrastructure";
  capture.qualification.infrastructureIndependenceProven = false;
  delete capture.qualification.selectedIndependentFamilies;
  for (const row of capture.rows) {
    row.storedSupplyMinusStoredBorrowAssets = row.availableLiquidityAssets;
    delete row.availableLiquidityAssets;
    row.marketStateSemantics = "Stored/unaccrued Morpho market state at the fixed pin; subtraction is an arithmetic identity, not independently measured liquidity.";
  }
  capture.materiality = {
    activeTwoMarketStoredSupplyAssetsRawUsdc: "2617552752545",
    allThreeStoredSupplyAssetsRawUsdc: "2617552753545",
    allThreeStoredBorrowAssetsRawUsdc: "2382684073594",
    activeTwoMarketStoredSupplyUsdc: "2617552.752545",
    allThreeStoredSupplyUsdc: "2617552.753545",
    allThreeStoredBorrowUsdc: "2382684.073594",
    storedUnaccruedAtMorphoMarketState: true,
    subtractionMeaning: "stored supply assets minus stored borrow assets; not independently measured available liquidity",
    materialMorphoState: true,
    pendleLiquidityHintsAuthoritative: false,
    conclusion: "MATERIAL_REVIEW_REQUIRED"
  };
  capture.oracleSemantics.linearDiscount = "modeled answer=1e18-floor(max(maturity-t,0)*0.2e18/31536000), monotonic in integer-second steps";
  capture.oracleSemantics.preExpiry = "Modeled PT/asset answer increases toward par in monotonic integer-second steps; it is not continuous.";
  capture.oracleSemantics.fixedQuoteDiscount = "approximately 2.5%; exact constant answer is 1,025,641,025,641 with 12 decimals";
  capture.oracleSemantics.apxUsdFeedAtPin = { updatedAt: "1787336351", pinTimestamp: "1787379671", ageSeconds: "43320",
    freshnessCharacterization: "observed age only; no unsupported recent/fresh claim and no consumer-enforced staleness bound" };
  capture.formulaAssessment = {
    mode: "MODELED_NOT_OBSERVED_AT_EXPIRY",
    frozenInputs: ["APX/USD answer", "quote-feed answer"],
    admittedFormulaExtraExpiryDiscontinuity: false,
    deployedEndToEndExpiryBehavior: "unknown",
    modeledPtLegLastStepWei: "6341958396",
    modeledPtLegLastStepPar: "0.000000006341958396",
    modeledBoundary: "The ordinary final integer-second step reaches par; no additional expiry-triggered jump exists in the admitted formula."
  };
  capture.sourceRuntime.explorer = "public Blockscout explorer candidate compiler bundles; partial rows are not exact verified source/runtime";
  capture.sourceRuntime.strictDeployedOracleFormulaBound = false;
  capture.sourceRuntime.deployedEndToEndExpiryBehavior = "unknown";
  capture.sourceRuntime.partialCandidateBundleCount = 6;
  capture.sourceRuntime.pendleMarketConstructorArgsCaveat = "The 0x30bb... Pendle market candidate bundle lacks constructor arguments.";
  capture.sourceRuntime.dependencyClosure = dependencyClosure();
  capture.sourceRuntime.reopenSequence = [
    "Reacquire authoritative compiler inputs for partial rows; derive all constructor immutables and linked libraries; save a reproducible patch ledger and exact runtime comparison evidence.",
    "Bind Morpho core exact source/runtime plus USDC proxy/implementation and token semantics.",
    "Capture SY adapter, yieldToken, asset, pause, owner/roles, underlying implementation, and redemption topology; then close PT/YT/SY redemption semantics.",
    "Select a concrete exit. Bind Pendle market constructor/library/immutable/runtime only if a Pendle-market exit is used; otherwise bind the selected exit venue.",
    "Only after protocol-loss, public reachability, and exit closure consider economics or a fork."
  ];
  capture.routeAssessment.protocolAccountingFlawEstablished = "unknown";
  capture.routeAssessment.deployedEndToEndExpiryBehavior = "unknown";
  capture.routeAssessment.publicActorToLiquidExtractionComplete = false;
  capture.routeAssessment.incompletePublicRoute = true;
  capture.routeAssessment.rationale = "The public route is incomplete; protocol flaw and deployed end-to-end expiry behavior remain unknown.";
  capture.evidence.localSemantic = { status: "PASS", result: "refutes",
    scope: "admitted formula only with APX/USD and quote answers frozen",
    rationale: "Modeled integer arithmetic has no extra expiry-triggered discontinuity beyond the ordinary final 6,341,958,396-wei PT-leg step." };
  capture.evidence.deployedEndToEnd = { status: "UNKNOWN", result: "inconclusive",
    rationale: "Strict wrapper, redemption, Morpho core/USDC, and route-specific closure is incomplete." };
  capture.evidence.reproducibility = { status: "UNKNOWN", result: "inconclusive",
    rationale: "Six explorer bundles are partial candidates; one market lacks constructor args; no immutable patch ledger or reproducible exact runtime build exists." };
  capture.gates.routePositive = "unknown";
  capture.gates.executableNow = "unknown";
  capture.gates.signedActionJustified = false;
  capture.gates.fork.justified = false;
  capture.gates.impactPath[0].supported = "unknown";
  capture.gates.impactPath[0].rationale = "Material state exists; protocol flaw and deployed end-to-end behavior remain unknown; no protocol-loss route is established.";
  return capture;
}

function correctSource(source, parentCommitment, correctedAt) {
  source.schema = `${NS}/source-runtime-manifest-v2-candidate-closure`;
  source.correction = { correctedAt, parentSha256: parentCommitment, offline: true };
  source.authority = { partialRows: "EXPLORER_CANDIDATE_COMPILER_BUNDLES_NOT_EXACT_VERIFIED_SOURCE_RUNTIME",
    pinnedRuntimeEquality: "Runtime bytes equal explorer-returned runtime bytes, but this alone does not prove source/compiler reconstruction.",
    broadRouteClosure: "Six partial rows are neither necessary nor sufficient for broad route closure." };
  source.constructorArguments = { missingCandidateBundles: ["0x30bb9ee8dc6aab322dc3a0d36063cbf06a9e5952"],
    presentCandidateBundles: ["0xc3e6cc9269dc780e0d55512c46cad1dd29cfbaa5"],
    reopenRequirement: "Derive/reacquire immutables and preserve a reproducible patch ledger/runtime comparison." };
  source.dependencyClosure = dependencyClosure();
  for (const row of source.contracts) if (PARTIAL.has(row.address)) {
    row.bundleAuthority = "EXPLORER_CANDIDATE_PARTIAL_NOT_EXACT";
    row.exactVerifiedSourceRuntime = false;
    row.explorerRuntimeEqualityNotSufficient = true;
  }
  return source;
}

function correctInputs(inputs, parentCommitment, source, correctedAt) {
  inputs.schema = `${NS}/explorer-candidate-compiler-bundles-v2`;
  inputs.correction = { correctedAt, parentSha256: parentCommitment, offline: true, originalFileNameRetainedForStableReferences: true };
  inputs.classification = "CANDIDATE_COMPILER_BUNDLES; PARTIAL ROWS ARE NOT EXACT VERIFIED SOURCE/RUNTIME";
  inputs.limitations = [
    "Six partial explorer rows require reproducible local compilation and exact runtime normalization before admission.",
    "The 0x30bb... Pendle market candidate lacks constructor arguments.",
    "Pinned runtime equality against explorer-returned runtime is not a source/compiler proof."
  ];
  const byAddress = new Map(source.contracts.map((row) => [row.address, row]));
  for (const row of inputs.contracts) {
    const manifest = byAddress.get(row.address);
    row.bundleAuthority = PARTIAL.has(row.address) ? "EXPLORER_CANDIDATE_PARTIAL_NOT_EXACT" : "EXPLORER_FULL_VERIFICATION_CANDIDATE";
    row.strictSourceRuntimeAdmitted = PARTIAL.has(row.address) ? false : manifest?.sourceRuntimeBound === true;
    if (row.contractName === "PendleMarketV7") row.constructorArgsStatus = row.constructorArgs ? "PRESENT_CANDIDATE" : "MISSING_CANDIDATE";
  }
  return inputs;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error("ARGV_FORBIDDEN");
  const checkMode = args[0] === "--check";
  const existingCorrection = fs.existsSync(PATHS.correction) ? json(PATHS.correction) : null;
  if (existingCorrection) validateExistingManifest(existingCorrection);
  const current = currentBytesAndCommitments();
  const state = classifyCommitments(current.commitments, existingCorrection);
  if (state === "ALREADY_CORRECTED") {
    console.log(JSON.stringify({ status: "ALREADY_CORRECTED", checkMode, writes: 0,
      corrected: current.commitments, correctionManifest: record(read(PATHS.correction)), network: false }));
    return;
  }
  const parent = existingCorrection?.parent || EXPECTED_PARENT;
  if (state !== "PARENT_READY") throw new Error("STATE_COMMITMENT_MISMATCH_NEITHER_PARENT_NOR_CORRECTED");
  if (checkMode) {
    console.log(JSON.stringify({ status: "PARENT_READY", checkMode: true, writes: 0, parent: current.commitments, network: false }));
    return;
  }
  const correctedAt = existingCorrection?.correctedAt || new Date().toISOString();
  const capture = correctCapture(JSON.parse(current.bytes.capture), parent.capture.sha256, correctedAt);
  const source = correctSource(JSON.parse(current.bytes.source), parent.source.sha256, correctedAt);
  const inputs = correctInputs(JSON.parse(current.bytes.inputs), parent.inputs.sha256, source, correctedAt);
  const outputBytes = { capture: serialized(capture), source: serialized(source), inputs: serialized(inputs) };
  const corrected = Object.fromEntries(Object.entries(outputBytes).map(([name, value]) => [name, record(value)]));
  if (existingCorrection && !sameCommitments(corrected, existingCorrection.corrected)) throw new Error("RECONSTRUCTION_COMMITMENT_MISMATCH");
  const manifest = { schema: `${NS}/oracle-review-correction-manifest-v2-rerun-safe`, correctedAt, status: "PASS_OFFLINE_CORRECTION",
    parent, corrected, corrections: ["canonical modeled/deployed expiry split", "integer-second last-step bound", "dependency-class closure",
      "candidate bundle authority", "stored/unaccrued materiality", "hostname-family heuristic", "APX feed age and approximate fixed quote"],
    rerunSafety: rerunSafety(),
    terminal: { status: "STOP_SOURCE_RUNTIME_GAP", material: true, finding: false, routePositive: "unknown", executableNow: "unknown",
      protocolAccountingFlaw: "unknown", deployedEndToEndExpiryBehavior: "unknown", economics: "N/A_UNOPENED", forkJustified: false,
      signedActionJustified: false },
    safety: { offline: true, network: false, rpc: false, inventoryRead: false, envRead: false, keyRead: false, fork: false,
      transaction: false, signing: false, broadcast: false, productionMutation: false } };
  // No filesystem mutation occurs before all state and reconstruction commitments
  // have passed. A partial external I/O failure can only be resumed from an exact
  // parent or corrected state; any mixed state is rejected on the next invocation.
  fs.writeFileSync(PATHS.capture, outputBytes.capture);
  fs.writeFileSync(PATHS.source, outputBytes.source);
  fs.writeFileSync(PATHS.inputs, outputBytes.inputs);
  write(PATHS.correction, manifest);
  console.log(JSON.stringify({ status: manifest.status, parentCapture: parent.capture.sha256, correctedCapture: corrected.capture.sha256,
    dependencyClasses: 4, partialCandidateBundles: 6, writes: 4, network: false }));
}

module.exports = { classifyCommitments };
if (require.main === module) try { main(); } catch (error) {
  console.error(JSON.stringify({ status: "FAIL", diagnostic: String(error.message || error).slice(0, 300) })); process.exitCode = 1;
}
