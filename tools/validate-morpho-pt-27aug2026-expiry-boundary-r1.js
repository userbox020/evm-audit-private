#!/usr/bin/env node
"use strict";

// Independent offline validator. Deliberately does not import the model.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NS = "morpho-pt-27aug2026-expiry-boundary-r1";
const PARENT = "morpho-pt-27aug2026-expiry-oracle-gate0";
const PARENT_DIR = path.join(ROOT, "reports", "raw", "fast", PARENT);
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", NS);
const MODEL_PATH = path.join(OUT_DIR, "model-v2.json");
const VALIDATION_PATH = path.join(OUT_DIR, "validation-v2.json");
const PATHS = Object.freeze({
  capture: path.join(PARENT_DIR, "capture.json"), inputs: path.join(PARENT_DIR, "verified-compiler-inputs.json"),
  source: path.join(PARENT_DIR, "source-runtime-manifest.json"), correction: path.join(PARENT_DIR, "correction-manifest.json"),
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
const LOCAL = Object.freeze({
  morpho: { bytes: 22622, sha256: "0xa164475f15d7b2876138b1e9c9e1570f6f84a221e082ecaf0b9655492cd3f1bc" },
  shares: { bytes: 2405, sha256: "0xbf61f8757750a636300f04d24d9a710b54898cb49e68a411d6680d08b690f404" },
  constants: { bytes: 798, sha256: "0xd4da73652fbcafe1da062390493a18973240a970f32ac3b5f4af83d4f3b20369" },
  math: { bytes: 1678, sha256: "0x1652e79a32d8f9b91eb91318c857b324c1329a515eaf964d6d2685abd3447bae" }
});
const EXPIRY = 1787788800n, WAD = 10n ** 18n, SCALE = 10n ** 36n;
const RATE = 2n * 10n ** 17n, YEAR = 31536000n, VA = 1n, VS = 1000000n;
let assertions = 0;
function check(condition, label) { assertions++; if (!condition) throw new Error(`VALIDATION_FAILED:${label}`); }
function same(actual, expected, label) { assertions++; try { assert.deepStrictEqual(actual, expected); } catch (_) { throw new Error(`VALIDATION_FAILED:${label}`); } }
const sha256 = (bytes) => `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const rel = (file) => path.relative(ROOT, file).replaceAll("\\", "/");
const min = (a, b) => a < b ? a : b, max = (a, b) => a > b ? a : b;
const clamp = (x, low, high) => min(max(x, low), high);
const absDiff = (a, b) => a >= b ? a - b : b - a;
const strings = (value) => JSON.parse(JSON.stringify(value, (_, x) => typeof x === "bigint" ? x.toString() : x));
const ceilDiv = (x, d) => x === 0n ? 0n : 1n + (x - 1n) / d;
const mulDown = (x, y, d) => x * y / d, mulUp = (x, y, d) => ceilDiv(x * y, d);
const linear = (t) => WAD - (EXPIRY > t ? (EXPIRY - t) * RATE / YEAR : 0n);
const price = (t, underlying, quote, scale) => scale * linear(t) * underlying / quote;
const assetsUp = (shares, assets, totalShares) => mulUp(shares, assets + VA, totalShares + VS);
const sharesDown = (assets, totalAssets, shares) => mulDown(assets, shares + VS, totalAssets + VA);
const collateralValue = (collateral, oraclePrice) => collateral * oraclePrice / SCALE;
const maxBorrow = (collateral, oraclePrice, lltv) => collateralValue(collateral, oraclePrice) * lltv / WAD;

function exactKeys(value, keys, label) {
  check(value && typeof value === "object" && !Array.isArray(value), `${label}:object`);
  same(Object.keys(value), keys, `${label}:keys`);
}
function decimal(value, label) { check(typeof value === "string" && /^-?(0|[1-9][0-9]{0,77})$/.test(value), `${label}:decimal`); return BigInt(value); }
function address(value, label) { check(typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value), `${label}:address`); return value; }
function hash(value, label) { check(typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value), `${label}:hash`); return value; }
function canonicalJson(bytes, parsed, label) { same(bytes, Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`), `${label}:canonical-bytes`); }

function state(row) {
  return { totalSupplyAssets: BigInt(row.marketState.totalSupplyAssets), totalSupplyShares: BigInt(row.marketState.totalSupplyShares),
    totalBorrowAssets: BigInt(row.marketState.totalBorrowAssets), totalBorrowShares: BigInt(row.marketState.totalBorrowShares), fee: BigInt(row.marketState.fee) };
}
function health(collateral, borrowShares, s, oraclePrice, lltv) {
  const borrowedAssets = assetsUp(borrowShares, s.totalBorrowAssets, s.totalBorrowShares);
  const collateralQuoted = collateralValue(collateral, oraclePrice);
  const maxBorrowAssets = collateralQuoted * lltv / WAD;
  return { borrowedAssets, collateralQuoted, maxBorrowAssets, healthy: maxBorrowAssets >= borrowedAssets,
    healthMargin: maxBorrowAssets - borrowedAssets };
}
function nearest(target, s) {
  if (s.totalBorrowShares === 0n) return { shares: 0n, assets: 0n, exact: target === 0n };
  const estimate = sharesDown(target, s.totalBorrowAssets, s.totalBorrowShares);
  const candidates = new Set([0n, s.totalBorrowShares]);
  for (let d = -3n; d <= 3n; d++) candidates.add(clamp(estimate + d, 0n, s.totalBorrowShares));
  let best;
  for (const shares of candidates) {
    const assets = assetsUp(shares, s.totalBorrowAssets, s.totalBorrowShares), distance = absDiff(assets, target);
    if (!best || distance < best.distance || (distance === best.distance && shares < best.shares)) best = { shares, assets, distance };
  }
  return { shares: best.shares, assets: best.assets, exact: best.distance === 0n };
}
function minimumCollateral(debt, oraclePrice, lltv, upper) {
  if (debt === 0n) return 0n;
  if (maxBorrow(upper, oraclePrice, lltv) < debt) return null;
  let low = 0n, high = upper;
  while (low < high) { const middle = (low + high) / 2n; if (maxBorrow(middle, oraclePrice, lltv) >= debt) high = middle; else low = middle + 1n; }
  return low;
}

function readInputs() {
  const records = {}, parsed = {};
  for (const name of Object.keys(EXPECTED)) {
    const bytes = fs.readFileSync(PATHS[name]);
    records[name] = { path: rel(PATHS[name]), bytes: bytes.length, sha256: sha256(bytes) };
    same(records[name], { path: rel(PATHS[name]), ...EXPECTED[name] }, `parent-commitment:${name}`);
    parsed[name] = JSON.parse(bytes.toString("utf8"));
  }
  check(parsed.validation.status === "PASS", "parent-validation-pass");
  for (const name of ["capture", "inputs", "source", "correction"])
    check(parsed.validation.artifacts[name].sha256 === records[name].sha256, `parent-validation-binds:${name}`);
  const local = {};
  for (const name of Object.keys(LOCAL)) {
    const bytes = fs.readFileSync(PATHS[name]);
    local[name] = { path: rel(PATHS[name]), bytes: bytes.length, sha256: sha256(bytes), authority: "PINNED_LOCAL_SEMANTIC_REFERENCE_ONLY" };
    same({ bytes: bytes.length, sha256: sha256(bytes) }, LOCAL[name], `local-commitment:${name}`);
  }
  return { records, parsed, local };
}

function bindingFor(row, inputs, manifest) {
  const wrapper = row.oracle.BASE_FEED_1, inner = row.feeds[wrapper].innerOracle.value;
  const result = { marketId: row.marketId };
  for (const [kind, addr, contractName, sourcePath, bound, blocker] of [
    ["morphoOracle", row.params.oracle, "MorphoChainlinkOracleV2", "src/morpho-chainlink/MorphoChainlinkOracleV2.sol", true, null],
    ["wrapper", wrapper, "PendleLinearDiscountOracleWrapper", "src/PendleLinearDiscountOracleWrapper.sol", false, "EXPLORER_PARTIAL_NOT_EXACT"],
    ["inner", inner, "PendleSparkLinearDiscountOracle", "contracts/pendle/contracts/oracles/internal/PendleSparkLinearDiscountOracle.sol", true, null]
  ]) {
    const mr = manifest.contracts.find((x) => x.address === addr), cr = inputs.contracts.find((x) => x.address === addr);
    check(mr?.contractName === contractName && cr?.contractName === contractName, `binding-record:${row.label}:${kind}`);
    check(mr.sourceRuntimeBound === bound && mr.bindingBlocker === blocker, `binding-authority:${row.label}:${kind}`);
    const hr = mr.sourceHashes.find((x) => x.sourcePath === sourcePath), content = cr.sources?.[sourcePath]?.content;
    check(typeof content === "string" && sha256(Buffer.from(content)) === hr?.sha256, `binding-source-hash:${row.label}:${kind}`);
    if (kind === "morphoOracle") check(content.includes("SCALE_FACTOR.mulDiv") && content.includes("BASE_FEED_1.getPrice()"), `tripwire:${row.label}:morpho`);
    if (kind === "wrapper") check(content.includes("innerOracle.latestRoundData()") && content.includes("updatedAt = block.timestamp"), `tripwire:${row.label}:wrapper`);
    if (kind === "inner") check(content.includes("maturity > block.timestamp") && content.includes("ONE - discount"), `tripwire:${row.label}:inner`);
    result[kind] = { address: addr, contractName, sourcePath, sha256: hr.sha256, sourceRuntimeBound: bound, bindingBlocker: blocker };
  }
  return result;
}

function expectedMarket(row, binding) {
  const s = state(row), lltv = BigInt(row.params.lltv), underlying = BigInt(row.oracleFormula.baseFeed2Answer);
  const quote = BigInt(row.oracleFormula.quoteFeed1Answer), scale = BigInt(row.oracle.SCALE_FACTOR), supply = BigInt(row.pt.totalSupply);
  const prices = { expiryMinusOne: price(EXPIRY - 1n, underlying, quote, scale), expiry: price(EXPIRY, underlying, quote, scale),
    expiryPlusOne: price(EXPIRY + 1n, underlying, quote, scale) };
  const debt = assetsUp(s.totalBorrowShares, s.totalBorrowAssets, s.totalBorrowShares);
  const envelope = s.totalBorrowShares === 0n ? 0n : minimumCollateral(debt, prices.expiryMinusOne, lltv, supply);
  const candidates = s.totalBorrowShares === 0n ? [] : [WAD, 1000n * WAD, 100000n * WAD, min(1000000n * WAD, envelope)];
  const anchors = [...new Set(candidates.filter((x) => x > 0n && x <= envelope).map(String))].map(BigInt), positions = [];
  for (const collateral of anchors) {
    const threshold = maxBorrow(collateral, prices.expiryMinusOne, lltv), targets = new Map();
    for (const requested of [-2n, -1n, 0n, 1n, 2n]) {
      const target = clamp(threshold + requested, 0n, debt), key = String(target);
      if (!targets.has(key)) targets.set(key, { target, requestedOffsets: [] });
      targets.get(key).requestedOffsets.push(requested);
    }
    for (const { target, requestedOffsets } of targets.values()) {
      const n = nearest(target, s), offset = n.assets - threshold;
      positions.push({ fixture: `C${collateral}:T${target}:A${offset >= 0n ? "+" : ""}${offset}`,
        authority: "SYNTHETIC_FIXED_PIN_FROZEN_STATE", collateral, expiryMinusOneMaxBorrow: threshold,
        targetBorrowAssetsAfterClamp: target, requestedOffsets, targetOffsetAfterClamp: target - threshold,
        borrowShares: n.shares, actualBorrowAssetsAtFrozenState: n.assets, actualBorrowAssetsOffsetFromThreshold: offset,
        exactTargetRepresentable: n.exact, aggregateConsistent: n.shares <= s.totalBorrowShares,
        frozenStateHealth: { expiryMinusOne: health(collateral, n.shares, s, prices.expiryMinusOne, lltv),
          expiry: health(collateral, n.shares, s, prices.expiry, lltv), expiryPlusOne: health(collateral, n.shares, s, prices.expiryPlusOne, lltv) } });
    }
  }
  return strings({ label: row.label, marketId: row.marketId, role: s.totalBorrowAssets === 0n ? "DUST_PAR_COMPARATOR" : "MATERIAL_ACTIVE_MARKET",
    committedSourceBinding: binding, params: { ...row.params }, storedState: s,
    storedSupplyMinusStoredBorrowAssets: s.totalSupplyAssets - s.totalBorrowAssets, storedSubtractionIsLiquidity: false, ptTotalSupplyRaw: supply,
    oracle: { configuration: quote === 1000000000000n ? "PAR_QUOTE" : "DISCOUNTED_QUOTE", frozenUnderlyingAnswer: underlying,
      frozenQuoteAnswer: quote, scaleFactor: scale, prices, ordinaryExpiryDelta: prices.expiry - prices.expiryMinusOne,
      postExpiryDelta: prices.expiryPlusOne - prices.expiry, formulaDiscrepancyToleranceRaw: 0n },
    controls: { noBorrow: health(WAD, 0n, s, prices.expiry, lltv),
      frozenNoCallStateDelta: { supplyAssets: 0n, supplyShares: 0n, borrowAssets: 0n, borrowShares: 0n },
      deficitInferenceFromFrozenNoCallControl: "NOT_PERMITTED" }, positions,
    concentrationUpperEnvelope: envelope === null ? null : { borrowShares: s.totalBorrowShares, borrowedAssets: debt,
      minimumCollateralHealthyAtExpiryMinusOne: envelope, authority: "SYNTHETIC_FIXED_PIN_FROZEN_STATE_NOT_DEPLOYED_POSITION" },
    entirePtSupplyOrdinaryStepUpperBound: { collateralAssumedRaw: supply,
      deltaCollateralValueRawUsdc: collateralValue(supply, prices.expiry) - collateralValue(supply, prices.expiryMinusOne),
      deltaMaximumBorrowRawUsdc: maxBorrow(supply, prices.expiry, lltv) - maxBorrow(supply, prices.expiryMinusOne, lltv),
      authority: "FIXED_PIN_FROZEN_FEEDS_SCENARIO_ONLY_NOT_CAPACITY_OR_AVAILABLE_COLLATERAL", availableCollateralClaim: false, routeCapacityClaim: false } });
}

function validateModel() {
  assertions = 0;
  const { records, parsed, local } = readInputs(), capture = parsed.capture;
  same(capture.schema, `${PARENT}/capture-v2-oracle-review-correction`, "capture-schema");
  same(parsed.inputs.schema, `${PARENT}/explorer-candidate-compiler-bundles-v2`, "inputs-schema");
  same(parsed.source.schema, `${PARENT}/source-runtime-manifest-v2-candidate-closure`, "source-schema");
  same(parsed.correction.status, "PASS_OFFLINE_CORRECTION", "correction-status");
  same(capture.formulaAssessment.admittedFormulaExtraExpiryDiscontinuity, false, "parent-formula-conclusion");
  same(capture.formulaAssessment.deployedEndToEndExpiryBehavior, "unknown", "parent-deployment-conclusion");
  const modelBytes = fs.readFileSync(MODEL_PATH), model = JSON.parse(modelBytes.toString("utf8"));
  canonicalJson(modelBytes, model, "model-v2");
  exactKeys(model, ["schema", "generatedAt", "status", "mode", "checks", "inputs", "boundary", "markets", "comparisons", "candidateRoutes", "evidence", "impactPath", "conclusion", "blockers", "safety"], "model");
  same(model.schema, `${NS}/model-v2`, "model-schema");
  check(typeof model.generatedAt === "string" && /^2026-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/.test(model.generatedAt), "generated-at-safe");
  same(model.status, "PASS_ORDINARY_EXPIRY_STEP_ONLY_WITH_DEPLOYMENT_BLOCKERS", "status");
  same(model.mode, "OFFLINE_DETERMINISTIC_EMULATION", "mode");
  check(Number.isSafeInteger(model.checks) && model.checks > 0 && model.checks < 1000, "model-check-count-bounded");
  exactKeys(model.inputs, ["commitmentsVerified", "artifacts", "authority", "localSourceReferences", "sourceTripwires"], "inputs");
  same(model.inputs.commitmentsVerified, true, "commitments-verified");
  same(model.inputs.artifacts, records, "published-parent-records");
  same(model.inputs.localSourceReferences, local, "published-local-records");
  same(model.inputs.authority, { fixedPinCapture: "IMMUTABLE_EVIDENCE", exactBoundRows: "EXACT_BOUND_SOURCE_PER_MANIFEST_ONLY",
    partialRows: "CANDIDATE_SOURCE_ONLY", localMorphoCore: "PINNED_LOCAL_SEMANTIC_REFERENCE_ONLY",
    positionsAndUpperBounds: "FIXED_PIN_FROZEN_FEEDS_SCENARIO_PARAMETER" }, "input-authority");
  same(model.inputs.sourceTripwires, { exactCommittedRecordBinding: true, morphoFormula: true, wrapperTimestamp: true,
    linearDiscount: true, localMorphoHealth: true, substringsAreTripwiresOnly: true }, "source-tripwires");

  const expectedBoundary = strings({ expiry: EXPIRY, timestamps: { expiryMinusOne: EXPIRY - 1n, expiry: EXPIRY, expiryPlusOne: EXPIRY + 1n },
    syntheticTimestampsNotChainBlocks: true, linearAnswers: { expiryMinusOne: linear(EXPIRY - 1n), expiry: linear(EXPIRY), expiryPlusOne: linear(EXPIRY + 1n) },
    ordinaryPtStep: linear(EXPIRY) - linear(EXPIRY - 1n), postExpiryPtStep: linear(EXPIRY + 1n) - linear(EXPIRY) });
  same(model.boundary, expectedBoundary, "boundary-recomputation");
  same(model.boundary.linearAnswers.expiryMinusOne, "999999993658041604", "exact-linear-before");
  same(model.boundary.ordinaryPtStep, "6341958396", "exact-ordinary-step");
  same(model.markets.length, 3, "market-count");
  const bindings = capture.rows.map((row) => bindingFor(row, parsed.inputs, parsed.source));
  const expectedMarkets = capture.rows.map((row, index) => expectedMarket(row, bindings[index]));
  same(model.markets, expectedMarkets, "all-market-semantics");
  for (const market of model.markets) {
    hash(market.marketId, `market:${market.label}:id`);
    const seen = new Set();
    for (const fixture of market.positions) {
      check(!seen.has(fixture.fixture), `fixture-deduplicated:${market.label}:${fixture.fixture}`); seen.add(fixture.fixture);
      decimal(fixture.targetOffsetAfterClamp, `fixture-target-offset:${market.label}`);
      decimal(fixture.actualBorrowAssetsOffsetFromThreshold, `fixture-actual-offset:${market.label}`);
      check(!(fixture.frozenStateHealth.expiryMinusOne.healthy && !fixture.frozenStateHealth.expiry.healthy), `health-conclusion:${market.label}`);
      same(fixture.frozenStateHealth.expiry, fixture.frozenStateHealth.expiryPlusOne, `post-expiry-health-flat:${market.label}`);
    }
    same(market.oracle.postExpiryDelta, "0", `post-expiry-price-flat:${market.label}`);
    check(decimal(market.entirePtSupplyOrdinaryStepUpperBound.deltaMaximumBorrowRawUsdc, `upper-bound:${market.label}`) >= 0n, `upper-bound-nonnegative:${market.label}`);
  }
  const d = capture.rows[1], p = capture.rows[2];
  const ids = { discountedOracle: d.params.oracle, parOracle: p.params.oracle, discountedQuoteFeed: d.oracle.QUOTE_FEED_1, parQuoteFeed: p.oracle.QUOTE_FEED_1 };
  Object.entries(ids).forEach(([name, value]) => address(value, `configuration:${name}`));
  const expectedComparisons = strings({ discountedVsPar: {
    sameApyPt: d.params.collateralToken === p.params.collateralToken, separateMorphoMarkets: d.marketId !== p.marketId,
    committedConfigurationIds: ids, noConfigurationSwitchAtExpiry: ids.discountedOracle !== ids.parOracle && ids.discountedQuoteFeed !== ids.parQuoteFeed,
    staticGapAtExpiryRawOracle: BigInt(expectedMarkets[2].oracle.prices.expiry) - BigInt(expectedMarkets[1].oracle.prices.expiry) },
    expiryControl: { admittedFormulaExtraExpiryDiscontinuity: false, frozenStoredStateOnly: true, formulaDiscrepancyToleranceRaw: 0n } });
  same(model.comparisons, expectedComparisons, "comparison-recomputation");
  same(model.candidateRoutes, [
    { route: "ACQUIRE_PT_SUPPLY_COLLATERAL_BORROW", status: "BLOCKED_ROUTE_ECONOMICS", routeComplete: "unknown", conservativeNetUsd: null },
    { route: "LIQUIDATE_SEIZE_PT_REDEEM_OR_SELL", status: "WATCH_STATIC_DISCOUNT_REDEMPTION_GAP", routeComplete: "unknown", conservativeNetUsd: null },
    { route: "ACQUIRE_PT_REDEEM_AFTER_EXPIRY", status: "BLOCKED_REDEMPTION_CLOSURE", routeComplete: "unknown", conservativeNetUsd: null }
  ], "route-gates");
  same(model.evidence, { localSemantic: { status: "PASS", scope: "admitted frozen-feed formula and pinned local Morpho comparator" },
    deployedTransitionClosure: { status: "UNKNOWN", rationale: "wrapper, Morpho core/USDC, accrual, redemption, and route closure remain incomplete" },
    upperBound: { status: "SCENARIO_ONLY", rationale: "entire PT supply with fixed-pin frozen feeds is not available collateral or route capacity" } }, "evidence-gates");
  same(model.impactPath, [
    { type: "protocol-loss", supported: "unknown", rationale: "frozen no-call state is not deployed transition closure" },
    { type: "victim-loss", supported: "unknown", rationale: "no borrower and redemption route evidence" }
  ], "impact-gates");
  same(model.conclusion, { admittedFormulaExtraExpiryDiscontinuity: false,
    oracleInducedHealthyToUnhealthyInFrozenNoCallState: false, timestampOnlyMorphoDeficit: "unknown",
    deployedEndToEndExpiryBehavior: "unknown", protocolAccountingFlaw: "unknown", routePositive: "unknown",
    executableNow: "unknown", signedActionJustified: false, fork: { justified: false, signedAction: false } }, "canonical-conclusions");
  same(model.blockers, ["BLOCKED_WRAPPER_EXACT_BINDING", "BLOCKED_MORPHO_CORE_USDC_AND_ORACLE_CLOSURE",
    "BLOCKED_SY_IMPLEMENTATION_AND_TOPOLOGY", "BLOCKED_NO_POSITION_EVIDENCE", "BLOCKED_ROUTE_ECONOMICS"], "blockers");
  same(model.safety, { offline: true, network: false, rpc: false, inventoryRead: false, envRead: false, keyRead: false,
    fork: false, transaction: false, signing: false, broadcast: false, productionMutation: false }, "safety");
  check(!JSON.stringify(model).includes("interestSensitivity") && !JSON.stringify(model).includes("timestampOnlyProtocolDeficitRawUsdc"), "unsafe-v1-fields-absent");
  return { model, modelBytes, records, local, markets: model.markets.length,
    fixtures: model.markets.reduce((sum, market) => sum + market.positions.length, 0), assertions };
}

function publish(file, value) {
  const parent = path.dirname(file);
  check(fs.statSync(parent).isDirectory(), "publication-parent-directory");
  check(!fs.existsSync(file), `publication-final-absent:${path.basename(file)}`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const temp = path.join(parent, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    same(fs.readFileSync(temp), bytes, "publication-temp-readback");
    fs.linkSync(temp, file);
    same(fs.readFileSync(file), bytes, "publication-final-readback");
    try { const d = fs.openSync(parent, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (error) {
      if (!["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error.code)) throw error;
    }
    fs.unlinkSync(temp);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) { /* never remove final */ }
    throw error;
  }
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function validationRecord(result) {
  return {
    schema: `${NS}/validation-v2`, generatedAt: new Date().toISOString(), status: "PASS",
    validatorIndependentOfModelImplementation: true,
    assertions: result.assertions,
    model: { path: rel(MODEL_PATH), bytes: result.modelBytes.length, sha256: sha256(result.modelBytes),
      schema: result.model.schema, modelChecks: result.model.checks },
    parentInputs: result.records, localSourceReferences: result.local,
    counts: { markets: result.markets, positionFixtures: result.fixtures },
    conclusions: { admittedFormulaExtraExpiryDiscontinuity: false, timestampOnlyMorphoDeficit: "unknown",
      deployedEndToEndExpiryBehavior: "unknown", protocolAccountingFlaw: "unknown", routePositive: "unknown",
      executableNow: "unknown", signedActionJustified: false, forkJustified: false },
    safety: { offline: true, network: false, rpc: false, inventoryRead: false, envRead: false,
      keyRead: false, fork: false, transaction: false, signing: false }
  };
}

function verifyExisting(record, result) {
  exactKeys(record, ["schema", "generatedAt", "status", "validatorIndependentOfModelImplementation", "assertions", "model", "parentInputs", "localSourceReferences", "counts", "conclusions", "safety"], "validation-record");
  same(record.schema, `${NS}/validation-v2`, "validation-schema");
  same(record.status, "PASS", "validation-status");
  same(record.validatorIndependentOfModelImplementation, true, "validation-independence");
  same(record.assertions, result.assertions, "validation-assertion-count");
  same(record.model, { path: rel(MODEL_PATH), bytes: result.modelBytes.length, sha256: sha256(result.modelBytes),
    schema: result.model.schema, modelChecks: result.model.checks }, "validation-model-binding");
  same(record.parentInputs, result.records, "validation-parent-binding");
  same(record.localSourceReferences, result.local, "validation-local-binding");
  same(record.counts, { markets: result.markets, positionFixtures: result.fixtures }, "validation-counts");
  same(record.conclusions, validationRecord(result).conclusions, "validation-conclusions");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--check", "--write-validation"].includes(args[0])) throw new Error("ARGV_FORBIDDEN_USE_CHECK_OR_WRITE_VALIDATION");
  const result = validateModel();
  const record = validationRecord(result);
  let publication = null;
  if (args[0] === "--write-validation") publication = publish(VALIDATION_PATH, record);
  else if (fs.existsSync(VALIDATION_PATH)) {
    const bytes = fs.readFileSync(VALIDATION_PATH), existing = JSON.parse(bytes.toString("utf8"));
    canonicalJson(bytes, existing, "validation-v2"); verifyExisting(existing, result);
  }
  console.log(JSON.stringify({ status: "PASS", mode: args[0].slice(2), assertions: result.assertions,
    modelChecks: result.model.checks, markets: result.markets, positionFixtures: result.fixtures,
    modelSha256: sha256(result.modelBytes), routePositive: "unknown", fork: false, wrote: Boolean(publication), publication }));
}

module.exports = { validateModel, validationRecord, MODEL_PATH, VALIDATION_PATH };
if (require.main === module) {
  try { main(); } catch (error) {
    console.error(JSON.stringify({ status: "FAIL", diagnostic: String(error.message || error).slice(0, 400) }));
    process.exitCode = 1;
  }
}
