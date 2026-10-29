#!/usr/bin/env node
"use strict";

// Deterministic offline-only expiry-boundary model. This file has no network,
// RPC, inventory, environment, key, fork, signing, or transaction path.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PARENT_NS = "morpho-pt-27aug2026-expiry-oracle-gate0";
const NS = "morpho-pt-27aug2026-expiry-boundary-r1";
const PARENT_DIR = path.join(ROOT, "reports", "raw", "fast", PARENT_NS);
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", NS);
const OUT_PATH = path.join(OUT_DIR, "model-v2.json");
const PATHS = Object.freeze({
  capture: path.join(PARENT_DIR, "capture.json"),
  inputs: path.join(PARENT_DIR, "verified-compiler-inputs.json"),
  source: path.join(PARENT_DIR, "source-runtime-manifest.json"),
  correction: path.join(PARENT_DIR, "correction-manifest.json"),
  validation: path.join(PARENT_DIR, "validation.json"),
  morpho: path.join(ROOT, "targets", "morpho-blue-oracles", "lib", "morpho-blue", "src", "Morpho.sol"),
  shares: path.join(ROOT, "targets", "morpho-blue-oracles", "lib", "morpho-blue", "src", "libraries", "SharesMathLib.sol"),
  constants: path.join(ROOT, "targets", "morpho-blue-oracles", "lib", "morpho-blue", "src", "libraries", "ConstantsLib.sol"),
  math: path.join(ROOT, "targets", "morpho-blue-oracles", "lib", "morpho-blue", "src", "libraries", "MathLib.sol")
});
const EXPECTED = Object.freeze({
  capture: { bytes: 44861, sha256: "0xff98edf6dc14fc16bc3a3a9e9f36c618c543330295ee5175daa18285bed6af4b" },
  inputs: { bytes: 1801534, sha256: "0x84fce38e932e87aa67e8720c92d16b354613f34fc06780dcfa434d3a020fa72c" },
  source: { bytes: 90365, sha256: "0x5e346c07febe50a72597e4b2c301da876c3984eab44a11f30b3a51d7af6522e0" },
  correction: { bytes: 2549, sha256: "0xf06b54d45af7ad0deff774e5c0436dfe75b76fc78d851c7466aefaeac1e3f7cc" },
  validation: { bytes: 6467, sha256: "0x14ef1bdab6eb7eaeff8464298a51025b8759a2117010b5aba8f454e25add99da" }
});
const LOCAL_EXPECTED = Object.freeze({
  morpho: { bytes: 22622, sha256: "0xa164475f15d7b2876138b1e9c9e1570f6f84a221e082ecaf0b9655492cd3f1bc" },
  shares: { bytes: 2405, sha256: "0xbf61f8757750a636300f04d24d9a710b54898cb49e68a411d6680d08b690f404" },
  constants: { bytes: 798, sha256: "0xd4da73652fbcafe1da062390493a18973240a970f32ac3b5f4af83d4f3b20369" },
  math: { bytes: 1678, sha256: "0x1652e79a32d8f9b91eb91318c857b324c1329a515eaf964d6d2685abd3447bae" }
});

const EXPIRY = 1787788800n;
const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const RATE_PER_YEAR = 2n * 10n ** 17n;
const YEAR = 31536000n;
const VIRTUAL_ASSETS = 1n;
const VIRTUAL_SHARES = 1000000n;
const ONE_PT = WAD;

const digest = (bytes) => `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const rel = (file) => path.relative(ROOT, file).replaceAll("\\", "/");
const min = (a, b) => a < b ? a : b;
const max = (a, b) => a > b ? a : b;
const clamp = (x, low, high) => min(max(x, low), high);
const absDiff = (a, b) => a >= b ? a - b : b - a;
const stringifyBigInts = (value) => JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));

function ceilDiv(x, d) {
  if (x < 0n || d <= 0n) throw new Error("INVALID_CEIL_DIV_DOMAIN");
  return x === 0n ? 0n : 1n + (x - 1n) / d;
}
const mulDivDown = (x, y, d) => (x * y) / d;
const mulDivUp = (x, y, d) => ceilDiv(x * y, d);
const linearAnswer = (timestamp) => WAD - mulDivDown(EXPIRY > timestamp ? EXPIRY - timestamp : 0n, RATE_PER_YEAR, YEAR);
const morphoPrice = (timestamp, underlying, quote, scale = 1n) => mulDivDown(scale, linearAnswer(timestamp) * underlying, quote);
const toAssetsUp = (shares, assets, totalShares) => mulDivUp(shares, assets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
const toSharesDown = (assets, totalAssets, shares) => mulDivDown(assets, shares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
const collateralValue = (collateral, price) => mulDivDown(collateral, price, ORACLE_PRICE_SCALE);
const maximumBorrow = (collateral, price, lltv) => mulDivDown(collateralValue(collateral, price), lltv, WAD);

function stateFromRow(row) {
  return {
    totalSupplyAssets: BigInt(row.marketState.totalSupplyAssets),
    totalSupplyShares: BigInt(row.marketState.totalSupplyShares),
    totalBorrowAssets: BigInt(row.marketState.totalBorrowAssets),
    totalBorrowShares: BigInt(row.marketState.totalBorrowShares),
    fee: BigInt(row.marketState.fee)
  };
}

function health(collateral, borrowShares, state, price, lltv) {
  const borrowedAssets = toAssetsUp(borrowShares, state.totalBorrowAssets, state.totalBorrowShares);
  const collateralQuoted = collateralValue(collateral, price);
  const maxBorrowAssets = mulDivDown(collateralQuoted, lltv, WAD);
  return { borrowedAssets, collateralQuoted, maxBorrowAssets, healthy: maxBorrowAssets >= borrowedAssets,
    healthMargin: maxBorrowAssets - borrowedAssets };
}

function nearestBorrowShares(target, state) {
  if (state.totalBorrowShares === 0n) return { shares: 0n, assets: 0n, exact: target === 0n };
  const estimate = toSharesDown(target, state.totalBorrowAssets, state.totalBorrowShares);
  const candidates = new Set([0n, state.totalBorrowShares]);
  for (let delta = -3n; delta <= 3n; delta++) candidates.add(clamp(estimate + delta, 0n, state.totalBorrowShares));
  let best;
  for (const shares of candidates) {
    const assets = toAssetsUp(shares, state.totalBorrowAssets, state.totalBorrowShares);
    const distance = absDiff(assets, target);
    if (!best || distance < best.distance || (distance === best.distance && shares < best.shares)) best = { shares, assets, distance };
  }
  return { shares: best.shares, assets: best.assets, exact: best.distance === 0n };
}

function minCollateralForDebt(debt, price, lltv, upper) {
  if (debt === 0n) return 0n;
  if (maximumBorrow(upper, price, lltv) < debt) return null;
  let low = 0n, high = upper;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (maximumBorrow(middle, price, lltv) >= debt) high = middle;
    else low = middle + 1n;
  }
  return low;
}

function committedInputs(check) {
  const artifacts = {}, parsed = {};
  for (const name of Object.keys(EXPECTED)) {
    const bytes = fs.readFileSync(PATHS[name]);
    artifacts[name] = { path: rel(PATHS[name]), bytes: bytes.length, sha256: digest(bytes) };
    check(bytes.length === EXPECTED[name].bytes, `parent-bytes:${name}`);
    check(artifacts[name].sha256 === EXPECTED[name].sha256, `parent-hash:${name}`);
    parsed[name] = JSON.parse(bytes.toString("utf8"));
  }
  check(parsed.validation.status === "PASS", "parent-validation-pass");
  for (const name of ["capture", "inputs", "source", "correction"])
    check(parsed.validation.artifacts[name].sha256 === artifacts[name].sha256, `parent-validation-binding:${name}`);
  return { artifacts, parsed };
}

function findManifestRecord(manifest, address) {
  return manifest.contracts.find((record) => record.address === address);
}
function findCompilerRecord(inputs, address) {
  return inputs.contracts.find((record) => record.address === address);
}
function sourceEntry(record, sourcePath) {
  const entry = record?.sources?.[sourcePath];
  if (!entry || typeof entry.content !== "string") throw new Error(`MISSING_COMMITTED_SOURCE:${record?.address}:${sourcePath}`);
  return entry.content;
}

function sourceEvidence(capture, inputs, manifest, check) {
  const localSourceReferences = {};
  for (const name of Object.keys(LOCAL_EXPECTED)) {
    const bytes = fs.readFileSync(PATHS[name]);
    const record = { path: rel(PATHS[name]), bytes: bytes.length, sha256: digest(bytes), authority: "PINNED_LOCAL_SEMANTIC_REFERENCE_ONLY" };
    check(record.bytes === LOCAL_EXPECTED[name].bytes, `local-bytes:${name}`);
    check(record.sha256 === LOCAL_EXPECTED[name].sha256, `local-hash:${name}`);
    localSourceReferences[name] = record;
  }
  const localMorpho = fs.readFileSync(PATHS.morpho, "utf8");
  const localShares = fs.readFileSync(PATHS.shares, "utf8");
  const localConstants = fs.readFileSync(PATHS.constants, "utf8");
  const localMath = fs.readFileSync(PATHS.math, "utf8");
  check(localMorpho.includes("function _isHealthy") && localMorpho.includes("ORACLE_PRICE_SCALE"), "tripwire:local-health");
  check(localShares.includes("toAssetsUp") && localShares.includes("VIRTUAL_SHARES"), "tripwire:local-shares");
  check(localConstants.includes("ORACLE_PRICE_SCALE") && localConstants.includes("LIQUIDATION_CURSOR"), "tripwire:local-constants");
  check(localMath.includes("mulDivDown") && localMath.includes("mulDivUp"), "tripwire:local-math");

  const bindings = capture.rows.map((row) => {
    const wrapperAddress = row.oracle.BASE_FEED_1;
    const innerAddress = row.feeds[wrapperAddress].innerOracle.value;
    const specs = [
      ["morphoOracle", row.params.oracle, "MorphoChainlinkOracleV2", "src/morpho-chainlink/MorphoChainlinkOracleV2.sol"],
      ["wrapper", wrapperAddress, "PendleLinearDiscountOracleWrapper", "src/PendleLinearDiscountOracleWrapper.sol"],
      ["inner", innerAddress, "PendleSparkLinearDiscountOracle", "contracts/pendle/contracts/oracles/internal/PendleSparkLinearDiscountOracle.sol"]
    ];
    const result = { marketId: row.marketId };
    for (const [kind, address, contractName, sourcePath] of specs) {
      const manifestRecord = findManifestRecord(manifest, address);
      const compilerRecord = findCompilerRecord(inputs, address);
      check(manifestRecord?.contractName === contractName, `manifest-record:${row.label}:${kind}`);
      check(compilerRecord?.contractName === contractName, `compiler-record:${row.label}:${kind}`);
      const hashRecord = manifestRecord.sourceHashes.find((item) => item.sourcePath === sourcePath);
      const content = sourceEntry(compilerRecord, sourcePath);
      check(digest(Buffer.from(content)) === hashRecord?.sha256, `source-record-hash:${row.label}:${kind}`);
      if (kind === "morphoOracle") check(manifestRecord.sourceRuntimeBound === true && manifestRecord.bindingBlocker === null, `exact-morpho:${row.label}`);
      if (kind === "wrapper") check(manifestRecord.sourceRuntimeBound === false && manifestRecord.bindingBlocker === "EXPLORER_PARTIAL_NOT_EXACT", `partial-wrapper:${row.label}`);
      if (kind === "inner") check(manifestRecord.sourceRuntimeBound === true && manifestRecord.bindingBlocker === null, `exact-inner:${row.label}`);
      if (kind === "morphoOracle") check(content.includes("SCALE_FACTOR.mulDiv") && content.includes("BASE_FEED_1.getPrice()"), `tripwire:morpho:${row.label}`);
      if (kind === "wrapper") check(content.includes("innerOracle.latestRoundData()") && content.includes("updatedAt = block.timestamp"), `tripwire:wrapper:${row.label}`);
      if (kind === "inner") check(content.includes("maturity > block.timestamp") && content.includes("ONE - discount"), `tripwire:inner:${row.label}`);
      result[kind] = { address, contractName, sourcePath, sha256: hashRecord.sha256,
        sourceRuntimeBound: manifestRecord.sourceRuntimeBound, bindingBlocker: manifestRecord.bindingBlocker };
    }
    return result;
  });
  check(manifest.dependencyClosure.oracleFormulaDependencies.status === "BLOCKED_WRAPPER_EXACT_BINDING", "wrapper-closure-blocked");
  check(manifest.dependencyClosure.morphoLiquidationProtocolLossDependencies.status === "BLOCKED_MORPHO_CORE_USDC_AND_ORACLE_CLOSURE", "morpho-closure-blocked");
  return { localSourceReferences, bindings, sourceTripwires: {
    exactCommittedRecordBinding: true, morphoFormula: true, wrapperTimestamp: true, linearDiscount: true,
    localMorphoHealth: true, substringsAreTripwiresOnly: true
  } };
}

function buildMarket(row, binding, check) {
  const state = stateFromRow(row);
  const lltv = BigInt(row.params.lltv);
  const underlying = BigInt(row.oracleFormula.baseFeed2Answer);
  const quote = BigInt(row.oracleFormula.quoteFeed1Answer);
  const scale = BigInt(row.oracle.SCALE_FACTOR);
  const totalSupply = BigInt(row.pt.totalSupply);
  const timestamps = [EXPIRY - 1n, EXPIRY, EXPIRY + 1n];
  const prices = {
    expiryMinusOne: morphoPrice(timestamps[0], underlying, quote, scale),
    expiry: morphoPrice(timestamps[1], underlying, quote, scale),
    expiryPlusOne: morphoPrice(timestamps[2], underlying, quote, scale)
  };
  check(prices.expiryMinusOne <= prices.expiry && prices.expiry === prices.expiryPlusOne, `price-shape:${row.label}`);
  check(state.fee === 0n, `stored-fee-zero:${row.label}`);
  check(state.totalSupplyAssets - state.totalBorrowAssets === BigInt(row.storedSupplyMinusStoredBorrowAssets), `stored-subtraction:${row.label}`);
  const maxDebt = toAssetsUp(state.totalBorrowShares, state.totalBorrowAssets, state.totalBorrowShares);
  const envelopeCollateral = state.totalBorrowShares === 0n ? 0n : minCollateralForDebt(maxDebt, prices.expiryMinusOne, lltv, totalSupply);
  check(state.totalBorrowShares === 0n || envelopeCollateral !== null, `upper-envelope-reachable:${row.label}`);
  const candidates = state.totalBorrowShares === 0n ? [] : [ONE_PT, 1000n * ONE_PT, 100000n * ONE_PT, min(1000000n * ONE_PT, envelopeCollateral)];
  const anchors = [...new Set(candidates.filter((x) => x > 0n && x <= envelopeCollateral).map(String))].map(BigInt);
  const positions = [];
  for (const collateral of anchors) {
    const threshold = maximumBorrow(collateral, prices.expiryMinusOne, lltv);
    const targets = new Map();
    for (const requestedOffset of [-2n, -1n, 0n, 1n, 2n]) {
      const target = clamp(threshold + requestedOffset, 0n, maxDebt);
      const key = target.toString();
      if (!targets.has(key)) targets.set(key, { target, requestedOffsets: [] });
      targets.get(key).requestedOffsets.push(requestedOffset);
    }
    for (const { target, requestedOffsets } of targets.values()) {
      const nearest = nearestBorrowShares(target, state);
      const before = health(collateral, nearest.shares, state, prices.expiryMinusOne, lltv);
      const at = health(collateral, nearest.shares, state, prices.expiry, lltv);
      const after = health(collateral, nearest.shares, state, prices.expiryPlusOne, lltv);
      const actualOffset = nearest.assets - threshold;
      check(!(before.healthy && !at.healthy), `no-healthy-to-unhealthy:${row.label}`);
      check(at.healthy === after.healthy && at.maxBorrowAssets === after.maxBorrowAssets, `post-expiry-flat:${row.label}`);
      positions.push({
        fixture: `C${collateral}:T${target}:A${actualOffset >= 0n ? "+" : ""}${actualOffset}`,
        authority: "SYNTHETIC_FIXED_PIN_FROZEN_STATE",
        collateral,
        expiryMinusOneMaxBorrow: threshold,
        targetBorrowAssetsAfterClamp: target,
        requestedOffsets,
        targetOffsetAfterClamp: target - threshold,
        borrowShares: nearest.shares,
        actualBorrowAssetsAtFrozenState: nearest.assets,
        actualBorrowAssetsOffsetFromThreshold: actualOffset,
        exactTargetRepresentable: nearest.exact,
        aggregateConsistent: nearest.shares <= state.totalBorrowShares,
        frozenStateHealth: { expiryMinusOne: before, expiry: at, expiryPlusOne: after }
      });
    }
  }
  check(new Set(positions.map((item) => item.fixture)).size === positions.length, `fixtures-deduplicated:${row.label}`);
  const deltaCollateral = collateralValue(totalSupply, prices.expiry) - collateralValue(totalSupply, prices.expiryMinusOne);
  const deltaBorrow = maximumBorrow(totalSupply, prices.expiry, lltv) - maximumBorrow(totalSupply, prices.expiryMinusOne, lltv);
  check(deltaCollateral >= 0n && deltaBorrow >= 0n, `upper-bound-nonnegative:${row.label}`);
  return {
    label: row.label, marketId: row.marketId,
    role: state.totalBorrowAssets === 0n ? "DUST_PAR_COMPARATOR" : "MATERIAL_ACTIVE_MARKET",
    committedSourceBinding: binding,
    params: { ...row.params }, storedState: state,
    storedSupplyMinusStoredBorrowAssets: state.totalSupplyAssets - state.totalBorrowAssets,
    storedSubtractionIsLiquidity: false, ptTotalSupplyRaw: totalSupply,
    oracle: {
      configuration: quote === 1000000000000n ? "PAR_QUOTE" : "DISCOUNTED_QUOTE",
      frozenUnderlyingAnswer: underlying, frozenQuoteAnswer: quote, scaleFactor: scale, prices,
      ordinaryExpiryDelta: prices.expiry - prices.expiryMinusOne,
      postExpiryDelta: prices.expiryPlusOne - prices.expiry,
      formulaDiscrepancyToleranceRaw: 0n
    },
    controls: {
      noBorrow: health(ONE_PT, 0n, state, prices.expiry, lltv),
      frozenNoCallStateDelta: { supplyAssets: 0n, supplyShares: 0n, borrowAssets: 0n, borrowShares: 0n },
      deficitInferenceFromFrozenNoCallControl: "NOT_PERMITTED"
    },
    positions,
    concentrationUpperEnvelope: envelopeCollateral === null ? null : {
      borrowShares: state.totalBorrowShares, borrowedAssets: maxDebt,
      minimumCollateralHealthyAtExpiryMinusOne: envelopeCollateral,
      authority: "SYNTHETIC_FIXED_PIN_FROZEN_STATE_NOT_DEPLOYED_POSITION"
    },
    entirePtSupplyOrdinaryStepUpperBound: {
      collateralAssumedRaw: totalSupply, deltaCollateralValueRawUsdc: deltaCollateral,
      deltaMaximumBorrowRawUsdc: deltaBorrow,
      authority: "FIXED_PIN_FROZEN_FEEDS_SCENARIO_ONLY_NOT_CAPACITY_OR_AVAILABLE_COLLATERAL",
      availableCollateralClaim: false, routeCapacityClaim: false
    }
  };
}

function buildModel(options = {}) {
  let checks = 0;
  const check = (condition, label) => { checks++; if (!condition) throw new Error(`CHECK_FAILED:${label}`); };
  const { artifacts, parsed } = committedInputs(check);
  const { capture, inputs, source, correction } = parsed;
  check(capture.schema === `${PARENT_NS}/capture-v2-oracle-review-correction`, "capture-schema");
  check(inputs.schema === `${PARENT_NS}/explorer-candidate-compiler-bundles-v2`, "inputs-schema");
  check(source.schema === `${PARENT_NS}/source-runtime-manifest-v2-candidate-closure`, "source-schema");
  check(correction.status === "PASS_OFFLINE_CORRECTION", "correction-status");
  check(capture.expiry.unix === EXPIRY.toString() && capture.rows.length === 3, "capture-scope");
  check(capture.formulaAssessment.admittedFormulaExtraExpiryDiscontinuity === false, "parent-formula-conclusion");
  check(capture.formulaAssessment.deployedEndToEndExpiryBehavior === "unknown", "parent-deployment-gate");
  const sources = sourceEvidence(capture, inputs, source, check);
  const boundary = {
    expiry: EXPIRY,
    timestamps: { expiryMinusOne: EXPIRY - 1n, expiry: EXPIRY, expiryPlusOne: EXPIRY + 1n },
    syntheticTimestampsNotChainBlocks: true,
    linearAnswers: { expiryMinusOne: linearAnswer(EXPIRY - 1n), expiry: linearAnswer(EXPIRY), expiryPlusOne: linearAnswer(EXPIRY + 1n) }
  };
  boundary.ordinaryPtStep = boundary.linearAnswers.expiry - boundary.linearAnswers.expiryMinusOne;
  boundary.postExpiryPtStep = boundary.linearAnswers.expiryPlusOne - boundary.linearAnswers.expiry;
  check(boundary.linearAnswers.expiryMinusOne === 999999993658041604n, "linear-before");
  check(boundary.linearAnswers.expiry === WAD && boundary.linearAnswers.expiryPlusOne === WAD, "linear-at-after");
  check(boundary.ordinaryPtStep === 6341958396n && boundary.postExpiryPtStep === 0n, "linear-steps");
  const markets = capture.rows.map((row, index) => buildMarket(row, sources.bindings[index], check));
  check(markets[0].oracle.prices.expiryMinusOne === 956946893931106496691175n, "discount-price-before");
  check(markets[0].oracle.prices.expiry === 956946900000023923672500n, "discount-price-expiry");
  check(markets[2].oracle.prices.expiryMinusOne === 981483993775469305660336n, "par-price-before");
  check(markets[2].oracle.prices.expiry === 981484000000000000000000n, "par-price-expiry");
  const discountedRow = capture.rows[1], parRow = capture.rows[2];
  const sameApyPt = discountedRow.params.collateralToken === parRow.params.collateralToken;
  const separateMorphoMarkets = discountedRow.marketId !== parRow.marketId;
  const committedConfigurationIds = {
    discountedOracle: discountedRow.params.oracle, parOracle: parRow.params.oracle,
    discountedQuoteFeed: discountedRow.oracle.QUOTE_FEED_1, parQuoteFeed: parRow.oracle.QUOTE_FEED_1
  };
  const noConfigurationSwitchAtExpiry = Object.values(committedConfigurationIds).every((value) => /^0x[0-9a-f]{40}$/.test(value)) &&
    committedConfigurationIds.discountedOracle !== committedConfigurationIds.parOracle &&
    committedConfigurationIds.discountedQuoteFeed !== committedConfigurationIds.parQuoteFeed;
  check(sameApyPt && separateMorphoMarkets, "apy-comparison-derived");
  check(noConfigurationSwitchAtExpiry, "configuration-identities-derived");
  const staticGap = markets[2].oracle.prices.expiry - markets[1].oracle.prices.expiry;
  check(staticGap === 24537099999976076327500n, "static-gap");
  check(markets.filter((market) => market.role === "MATERIAL_ACTIVE_MARKET")
    .every((market) => market.entirePtSupplyOrdinaryStepUpperBound.deltaMaximumBorrowRawUsdc < 1000000n), "active-upper-bound-under-usdc");

  const model = {
    schema: `${NS}/model-v2`,
    generatedAt: options.generatedAt || new Date().toISOString(),
    status: "PASS_ORDINARY_EXPIRY_STEP_ONLY_WITH_DEPLOYMENT_BLOCKERS",
    mode: "OFFLINE_DETERMINISTIC_EMULATION",
    checks: 0,
    inputs: {
      commitmentsVerified: true, artifacts,
      authority: { fixedPinCapture: "IMMUTABLE_EVIDENCE", exactBoundRows: "EXACT_BOUND_SOURCE_PER_MANIFEST_ONLY",
        partialRows: "CANDIDATE_SOURCE_ONLY", localMorphoCore: "PINNED_LOCAL_SEMANTIC_REFERENCE_ONLY",
        positionsAndUpperBounds: "FIXED_PIN_FROZEN_FEEDS_SCENARIO_PARAMETER" },
      localSourceReferences: sources.localSourceReferences,
      sourceTripwires: sources.sourceTripwires
    },
    boundary, markets,
    comparisons: {
      discountedVsPar: { sameApyPt, separateMorphoMarkets, committedConfigurationIds,
        noConfigurationSwitchAtExpiry, staticGapAtExpiryRawOracle: staticGap },
      expiryControl: { admittedFormulaExtraExpiryDiscontinuity: false,
        frozenStoredStateOnly: true, formulaDiscrepancyToleranceRaw: 0n }
    },
    candidateRoutes: [
      { route: "ACQUIRE_PT_SUPPLY_COLLATERAL_BORROW", status: "BLOCKED_ROUTE_ECONOMICS", routeComplete: "unknown", conservativeNetUsd: null },
      { route: "LIQUIDATE_SEIZE_PT_REDEEM_OR_SELL", status: "WATCH_STATIC_DISCOUNT_REDEMPTION_GAP", routeComplete: "unknown", conservativeNetUsd: null },
      { route: "ACQUIRE_PT_REDEEM_AFTER_EXPIRY", status: "BLOCKED_REDEMPTION_CLOSURE", routeComplete: "unknown", conservativeNetUsd: null }
    ],
    evidence: {
      localSemantic: { status: "PASS", scope: "admitted frozen-feed formula and pinned local Morpho comparator" },
      deployedTransitionClosure: { status: "UNKNOWN", rationale: "wrapper, Morpho core/USDC, accrual, redemption, and route closure remain incomplete" },
      upperBound: { status: "SCENARIO_ONLY", rationale: "entire PT supply with fixed-pin frozen feeds is not available collateral or route capacity" }
    },
    impactPath: [
      { type: "protocol-loss", supported: "unknown", rationale: "frozen no-call state is not deployed transition closure" },
      { type: "victim-loss", supported: "unknown", rationale: "no borrower and redemption route evidence" }
    ],
    conclusion: {
      admittedFormulaExtraExpiryDiscontinuity: false,
      oracleInducedHealthyToUnhealthyInFrozenNoCallState: false,
      timestampOnlyMorphoDeficit: "unknown",
      deployedEndToEndExpiryBehavior: "unknown",
      protocolAccountingFlaw: "unknown",
      routePositive: "unknown",
      executableNow: "unknown",
      signedActionJustified: false,
      fork: { justified: false, signedAction: false }
    },
    blockers: ["BLOCKED_WRAPPER_EXACT_BINDING", "BLOCKED_MORPHO_CORE_USDC_AND_ORACLE_CLOSURE",
      "BLOCKED_SY_IMPLEMENTATION_AND_TOPOLOGY", "BLOCKED_NO_POSITION_EVIDENCE", "BLOCKED_ROUTE_ECONOMICS"],
    safety: { offline: true, network: false, rpc: false, inventoryRead: false, envRead: false,
      keyRead: false, fork: false, transaction: false, signing: false, broadcast: false, productionMutation: false }
  };
  model.checks = checks;
  return stringifyBigInts(model);
}

function durablePublishNoOverwrite(file, value) {
  const parent = path.dirname(file);
  const stat = fs.statSync(parent);
  if (!stat.isDirectory()) throw new Error("OUTPUT_PARENT_NOT_STABLE_DIRECTORY");
  if (fs.existsSync(file)) throw new Error(`FINAL_ALREADY_EXISTS:${path.basename(file)}`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const temporary = path.join(parent, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    const readback = fs.readFileSync(temporary);
    if (!readback.equals(bytes)) throw new Error("TEMP_READBACK_MISMATCH");
    fs.linkSync(temporary, file); // atomic no-overwrite commit on the same filesystem.
    const finalReadback = fs.readFileSync(file);
    if (!finalReadback.equals(bytes)) throw new Error("FINAL_READBACK_MISMATCH");
    try { const dirFd = fs.openSync(parent, "r"); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); } } catch (error) {
      if (!["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error.code)) throw error;
    }
    fs.unlinkSync(temporary);
    return { bytes: bytes.length, sha256: digest(bytes) };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) { /* final is never removed */ }
    throw error;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--check", "--write-v2"].includes(args[0])) throw new Error("ARGV_FORBIDDEN_USE_CHECK_OR_WRITE_V2");
  const output = buildModel();
  const publication = args[0] === "--write-v2" ? durablePublishNoOverwrite(OUT_PATH, output) : null;
  console.log(JSON.stringify({ status: output.status, mode: args[0].slice(2), checks: output.checks,
    markets: output.markets.length, positionFixtures: output.markets.reduce((sum, market) => sum + market.positions.length, 0),
    admittedFormulaExtraExpiryDiscontinuity: false, timestampOnlyMorphoDeficit: "unknown",
    routePositive: "unknown", fork: false, wrote: Boolean(publication), publication }));
}

module.exports = { buildModel, durablePublishNoOverwrite, OUT_PATH };
if (require.main === module) {
  try { main(); } catch (error) {
    console.error(JSON.stringify({ status: "FAIL", diagnostic: String(error.message || error).slice(0, 400) }));
    process.exitCode = 1;
  }
}
