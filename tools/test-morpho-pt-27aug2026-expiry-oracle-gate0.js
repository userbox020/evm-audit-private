#!/usr/bin/env node
"use strict";

// Offline source/formula differential tests for the branch capture. No network,
// provider inventory, environment, key, fork, signing, or transaction access.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NS = "morpho-pt-27aug2026-expiry-oracle-gate0";
const DIR = path.join(ROOT, "reports", "raw", "fast", NS);
const CAPTURE_PATH = path.join(DIR, "capture.json");
const INPUTS_PATH = path.join(DIR, "verified-compiler-inputs.json");
const SOURCE_MANIFEST_PATH = path.join(DIR, "source-runtime-manifest.json");
const CORRECTION_PATH = path.join(DIR, "correction-manifest.json");
const OUT = path.join(DIR, "test-results.json");
const EXPIRY = 1787788800n, ONE = 1000000000000000000n, RATE = 200000000000000000n, YEAR = 31536000n;

const sha256 = (bytes) => `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
let assertions = 0;
function assert(condition, message) { assertions++; if (!condition) throw new Error(`ASSERTION_FAILED:${message}`); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function linearAnswer(timestamp) {
  const timeLeft = EXPIRY > timestamp ? EXPIRY - timestamp : 0n;
  return ONE - (timeLeft * RATE) / YEAR;
}
function morphoPrice(timestamp, underlyingAnswer, quoteAnswer) {
  return (linearAnswer(timestamp) * underlyingAnswer) / quoteAnswer;
}
function allSources(inputs) {
  const rows = [];
  for (const contract of inputs.contracts) for (const [sourcePath, entry] of Object.entries(contract.sources || {}))
    rows.push({ address: contract.address, contractName: contract.contractName, sourcePath, content: entry.content });
  return rows;
}
function sourceBy(sources, contractName, suffix) {
  const row = sources.find((item) => item.contractName === contractName && item.sourcePath.endsWith(suffix));
  assert(Boolean(row), `source:${contractName}:${suffix}`); return row.content;
}

function main() {
  if (process.argv.length !== 2) throw new Error("ARGV_FORBIDDEN");
  const captureBytes = fs.readFileSync(CAPTURE_PATH), inputsBytes = fs.readFileSync(INPUTS_PATH), manifestBytes = fs.readFileSync(SOURCE_MANIFEST_PATH),
    correctionBytes = fs.readFileSync(CORRECTION_PATH);
  const capture = JSON.parse(captureBytes), inputs = JSON.parse(inputsBytes), sourceManifest = JSON.parse(manifestBytes),
    correction = JSON.parse(correctionBytes), sources = allSources(inputs);
  assert(capture.schema === `${NS}/capture-v2-oracle-review-correction`, "capture-schema");
  assert(capture.chain.statePin.blockHash === capture.chain.finalizedBlock.hash && capture.chain.statePin.requireCanonical === true, "eip1898-pin");
  assert(capture.chain.twoDistinctHostnameFamiliesAgreedUnderCaptureHeuristic === true && capture.chain.infrastructureIndependenceProven === false
    && capture.chain.terminalRecheckExact === true, "hostname-family-terminal");
  assert(capture.rows.length === 3, "three-rows");
  assert(sourceManifest.gaps.length > 0 && capture.status === "STOP_SOURCE_RUNTIME_GAP", "fail-closed-source-gap");
  assert(correction.schema === `${NS}/oracle-review-correction-manifest-v2-rerun-safe`
    && correction.status === "PASS_OFFLINE_CORRECTION" && correction.safety.network === false && correction.safety.rpc === false, "offline-correction");
  assert(correction.rerunSafety.stateMachine.correctedMatch === "ALREADY_CORRECTED_ZERO_WRITES"
    && correction.rerunSafety.stateMachine.parentMatch === "APPLY_EXACTLY_ONCE"
    && correction.rerunSafety.stateMachine.neitherMatch === "FAIL_BEFORE_ANY_WRITE", "rerun-safety-state-machine");

  const morphoSource = sourceBy(sources, "MorphoChainlinkOracleV2", "MorphoChainlinkOracleV2.sol");
  const chainlinkLib = sources.find((row) => row.sourcePath.endsWith("ChainlinkDataFeedLib.sol"))?.content;
  const wrapperSource = sourceBy(sources, "PendleLinearDiscountOracleWrapper", "PendleLinearDiscountOracleWrapper.sol");
  const innerSource = sourceBy(sources, "PendleSparkLinearDiscountOracle", "PendleSparkLinearDiscountOracle.sol");
  const ptSource = sourceBy(sources, "PendlePrincipalToken", "PendlePrincipalToken.sol");
  const ytSource = sourceBy(sources, "PendleYieldToken", "PendleYieldToken.sol");
  const miniHelpers = sources.find((row) => row.sourcePath.endsWith("MiniHelpers.sol"))?.content;
  assert(morphoSource.includes("SCALE_FACTOR.mulDiv") && morphoSource.includes("BASE_FEED_1.getPrice() * BASE_FEED_2.getPrice()"), "morpho-formula-tripwire");
  assert(Boolean(chainlinkLib) && chainlinkLib.includes("feed.latestRoundData()") && chainlinkLib.includes("answer >= 0"), "chainlink-answer-tripwire");
  assert(!chainlinkLib.includes("updatedAt >") && !chainlinkLib.includes("answeredInRound >="), "no-consumer-freshness-tripwire");
  assert(wrapperSource.includes("innerOracle.latestRoundData()") && wrapperSource.includes("updatedAt = block.timestamp"), "wrapper-tripwire");
  assert(innerSource.includes("maturity > block.timestamp") && innerSource.includes("ONE - discount") && innerSource.includes("365 days"), "linear-source-tripwire");
  assert(ptSource.includes("MiniHelpers.isCurrentlyExpired(expiry)"), "pt-expiry-tripwire");
  assert(Boolean(miniHelpers) && miniHelpers.includes("expiry <= block.timestamp"), "expiry-inclusive-tripwire");
  assert(ytSource.includes("if (!isExpired()) _burn") && ytSource.includes("SYUtils.assetToSy(indexCurrent, amountPY)"), "redeem-source-tripwire");

  const boundary = [EXPIRY - 2n, EXPIRY - 1n, EXPIRY, EXPIRY + 1n, EXPIRY + 2n].map((timestamp) => ({ timestamp, answer: linearAnswer(timestamp) }));
  assert(boundary[0].answer <= boundary[1].answer && boundary[1].answer <= boundary[2].answer, "pre-expiry-monotonic");
  assert(boundary[2].answer === ONE && boundary[3].answer === ONE && boundary[4].answer === ONE, "at-post-par");
  assert(boundary[2].answer - boundary[1].answer === 6341958396n, "exact-last-integer-second-step");
  assert(capture.formulaAssessment.mode === "MODELED_NOT_OBSERVED_AT_EXPIRY"
    && capture.formulaAssessment.admittedFormulaExtraExpiryDiscontinuity === false
    && capture.formulaAssessment.deployedEndToEndExpiryBehavior === "unknown"
    && capture.formulaAssessment.modeledPtLegLastStepWei === "6341958396", "canonical-formula-split");
  let prior = 0n;
  for (let secondsLeft = 604800n; secondsLeft >= 0n; secondsLeft -= 37n) {
    const answer = linearAnswer(EXPIRY - secondsLeft); assert(answer >= prior, "sampled-monotonic"); prior = answer;
  }
  assert(linearAnswer(0n) < 0n, "predeployment-discount-overflow-domain");
  for (const timestamp of [EXPIRY - 5n * YEAR, EXPIRY - YEAR, EXPIRY - 1n, EXPIRY, EXPIRY + 1n, (1n << 64n) - 1n]) {
    const answer = linearAnswer(timestamp); assert(answer >= 0n && answer <= ONE, "answer-range");
  }

  const rowResults = [];
  for (const row of capture.rows) {
    assert(row.marketId === row.marketIdComputed && row.marketIdVerified === true, `market-id:${row.label}`);
    assert(row.params.lltv === "860000000000000000" && row.params.loanToken === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", `params:${row.label}`);
    assert(row.pt.expiry === EXPIRY.toString() && row.pendleMarket.expiry === EXPIRY.toString(), `expiry:${row.label}`);
    assert(row.linearDiscount.twapDuration === "n/a" && row.linearDiscount.observationCardinalityDependency === "n/a", `no-twap:${row.label}`);
    const timestamp = BigInt(capture.chain.finalizedBlock.timestamp), underlying = BigInt(row.oracleFormula.baseFeed2Answer), quote = BigInt(row.oracleFormula.quoteFeed1Answer);
    const current = morphoPrice(timestamp, underlying, quote);
    assert(current === BigInt(row.oracle.price) && current === BigInt(row.oracleFormula.computedPrice), `captured-price:${row.label}`);
    const before = morphoPrice(EXPIRY - 1n, underlying, quote), at = morphoPrice(EXPIRY, underlying, quote), after = morphoPrice(EXPIRY + 1n, underlying, quote);
    assert(before <= at && at === after, `price-boundary:${row.label}`);
    assert(at - before <= (underlying * ((RATE + YEAR - 1n) / YEAR) + quote - 1n) / quote, `price-rounding-bound:${row.label}`);
    assert(BigInt(row.marketState.totalSupplyAssets) >= BigInt(row.marketState.totalBorrowAssets), `stored-subtraction-domain:${row.label}`);
    assert(BigInt(row.storedSupplyMinusStoredBorrowAssets) === BigInt(row.marketState.totalSupplyAssets) - BigInt(row.marketState.totalBorrowAssets),
      `stored-subtraction-arithmetic-identity:${row.label}`);
    assert(row.marketStateSemantics.includes("Stored/unaccrued") && row.marketStateSemantics.includes("arithmetic identity"), `stored-state-label:${row.label}`);
    rowResults.push({ label: row.label, modeledBeforeExpiryMinusOne: before.toString(), modeledAtExpiry: at.toString(), modeledAfterExpiryPlusOne: after.toString(),
      modeledFrozenFeedBoundaryDelta: (at - before).toString(), storedSupplyAssets: row.marketState.totalSupplyAssets,
      storedBorrowAssets: row.marketState.totalBorrowAssets, storedSupplyMinusStoredBorrowAssets: row.storedSupplyMinusStoredBorrowAssets });
  }
  assert(capture.rows[0].oracleFormula.quoteFeed1Answer === capture.rows[1].oracleFormula.quoteFeed1Answer, "same-discount-quote");
  assert(capture.rows[1].oracleFormula.baseFeed1Answer === capture.rows[2].oracleFormula.baseFeed1Answer, "same-apy-linear-leg");
  assert(BigInt(capture.rows[1].oracle.price) < BigInt(capture.rows[2].oracle.price), "discounted-below-par-quote");
  const allSupply = capture.rows.reduce((sum, row) => sum + BigInt(row.marketState.totalSupplyAssets), 0n),
    activeSupply = capture.rows.slice(0, 2).reduce((sum, row) => sum + BigInt(row.marketState.totalSupplyAssets), 0n),
    allBorrow = capture.rows.reduce((sum, row) => sum + BigInt(row.marketState.totalBorrowAssets), 0n);
  assert(activeSupply === 2617552752545n && capture.materiality.activeTwoMarketStoredSupplyAssetsRawUsdc === activeSupply.toString(), "active-stored-supply");
  assert(allSupply === 2617552753545n && capture.materiality.allThreeStoredSupplyAssetsRawUsdc === allSupply.toString(), "all-stored-supply");
  assert(allBorrow === 2382684073594n && capture.materiality.allThreeStoredBorrowAssetsRawUsdc === allBorrow.toString(), "all-stored-borrow");
  assert(capture.materiality.storedUnaccruedAtMorphoMarketState === true && capture.materiality.subtractionMeaning.includes("not independently measured"), "materiality-semantics");
  const classes = sourceManifest.dependencyClosure;
  assert(Object.keys(classes).length === 4, "four-dependency-classes");
  assert(classes.oracleFormulaDependencies.status === "BLOCKED_WRAPPER_EXACT_BINDING" && classes.oracleFormulaDependencies.pendleMarketsRequired === false, "oracle-class");
  assert(classes.ptYtSyRedemptionDependencies.status === "BLOCKED_SY_IMPLEMENTATION_AND_TOPOLOGY", "redemption-class");
  assert(classes.morphoLiquidationProtocolLossDependencies.status === "BLOCKED_MORPHO_CORE_USDC_AND_ORACLE_CLOSURE", "morpho-loss-class");
  assert(classes.routeSpecificExitDependencies.status === "NOT_OPENED_NO_ROUTE"
    && classes.routeSpecificExitDependencies.pendleMarketExit.requiredOnlyIfSelected === true, "exit-class");
  assert(inputs.classification.includes("CANDIDATE_COMPILER_BUNDLES")
    && inputs.contracts.filter((row) => row.bundleAuthority === "EXPLORER_CANDIDATE_PARTIAL_NOT_EXACT").length === 6, "candidate-bundle-count");
  assert(inputs.contracts.find((row) => row.address === "0x30bb9ee8dc6aab322dc3a0d36063cbf06a9e5952").constructorArgsStatus === "MISSING_CANDIDATE", "missing-market-constructor");
  assert(capture.oracleSemantics.apxUsdFeedAtPin.ageSeconds === "43320" && capture.oracleSemantics.fixedQuoteDiscount.startsWith("approximately 2.5%"), "feed-age-quote-label");
  assert(capture.gates.routePositive === "unknown" && capture.gates.executableNow === "unknown", "canonical-unknown-gates");
  assert(capture.gates.signedActionJustified === false && capture.gates.fork.justified === false, "safety-gates");

  const output = { schema: `${NS}/test-results-v2-oracle-review-correction`, generatedAt: new Date().toISOString(), status: "PASS",
    assertions, sampledBoundaryCases: 5, sampledMonotonicCases: Number(604800n / 37n) + 1,
    inputs: { capture: { path: `reports/raw/fast/${NS}/capture.json`, sha256: sha256(captureBytes) },
      compilerInputs: { path: `reports/raw/fast/${NS}/verified-compiler-inputs.json`, sha256: sha256(inputsBytes) },
      sourceRuntimeManifest: { path: `reports/raw/fast/${NS}/source-runtime-manifest.json`, sha256: sha256(manifestBytes) },
      correctionManifest: { path: `reports/raw/fast/${NS}/correction-manifest.json`, sha256: sha256(correctionBytes) } },
    sourceTripwires: { morphoFormula: true, noFreshnessEnforcement: true, wrapperTimestampRewrite: true,
      linearDiscount: true, inclusiveExpiry: true, postExpiryRedeem: true },
    result: { mode: "MODELED_NOT_OBSERVED_AT_EXPIRY", frozenInputs: ["APX/USD answer", "quote-feed answer"],
      admittedFormulaExtraExpiryDiscontinuity: false, deployedEndToEndExpiryBehavior: "unknown",
      modeledPtLegLastStepWei: "6341958396", atAndPostExpiryFormulaPar: true, integerStepRoundingBounded: true,
      twapOrCardinalityDependency: "n/a", dependencyClassesAsserted: 4, partialCandidateBundles: 6,
      sourceRuntimeGapRetained: true, publicRouteComplete: false, forkJustified: false },
    rows: rowResults,
    safety: { offline: true, network: false, inventoryRead: false, envRead: false, keyRead: false, fork: false,
      transaction: false, signing: false, broadcast: false, productionMutation: false } };
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ status: output.status, assertions, admittedFormulaExtraExpiryDiscontinuity: false,
    deployedEndToEndExpiryBehavior: "unknown", dependencyClasses: 4, sourceRuntimeGapRetained: true }));
}

try { main(); } catch (error) { console.error(JSON.stringify({ status: "FAIL", diagnostic: String(error.message || error).slice(0, 300) })); process.exitCode = 1; }
