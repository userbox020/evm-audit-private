#!/usr/bin/env node
"use strict";

// Offline package test. The independent validator is executed as a separate
// process; this test never imports the model implementation.
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NS = "morpho-pt-27aug2026-expiry-boundary-r1";
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", NS);
const MODEL_PATH = path.join(OUT_DIR, "model-v2.json");
const VALIDATION_PATH = path.join(OUT_DIR, "validation-v2.json");
const RESULT_PATH = path.join(OUT_DIR, "test-result-v2.json");
const VALIDATOR = path.join(__dirname, "validate-morpho-pt-27aug2026-expiry-boundary-r1.js");
const SEMANTIC_SECTIONS = ["inputs", "boundary", "markets", "comparisons", "candidateRoutes", "evidence", "impactPath", "conclusion", "blockers", "safety"];
const EXPECTED_ASSERTIONS = 178;
let assertions = 0;
function ok(condition, label) { assertions++; if (!condition) throw new Error(`ASSERTION_FAILED:${label}`); }
function same(actual, expected, label) { assertions++; try { assert.deepStrictEqual(actual, expected); } catch (_) { throw new Error(`ASSERTION_FAILED:${label}`); } }
const sha256 = (bytes) => `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const rel = (file) => path.relative(ROOT, file).replaceAll("\\", "/");

function canonicalRead(file, label) {
  const bytes = fs.readFileSync(file), value = JSON.parse(bytes.toString("utf8"));
  same(bytes, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), `${label}:canonical`);
  return { bytes, value };
}

function publishNoOverwrite(file, value) {
  const parent = path.dirname(file);
  if (!fs.statSync(parent).isDirectory()) throw new Error("OUTPUT_PARENT_NOT_STABLE_DIRECTORY");
  if (fs.existsSync(file)) throw new Error(`FINAL_ALREADY_EXISTS:${path.basename(file)}`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const temp = path.join(parent, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (!fs.readFileSync(temp).equals(bytes)) throw new Error("TEMP_READBACK_MISMATCH");
    fs.linkSync(temp, file);
    if (!fs.readFileSync(file).equals(bytes)) throw new Error("FINAL_READBACK_MISMATCH");
    try { const d = fs.openSync(parent, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (error) {
      if (!["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error.code)) throw error;
    }
    fs.unlinkSync(temp);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) { /* final is never removed */ }
    throw error;
  }
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function resultRecord(modelFile, validationFile, validatorOutput, fixtures, coreAssertions) {
  return {
    schema: `${NS}/test-result-v2`, generatedAt: new Date().toISOString(), status: "PASS",
    assertions: coreAssertions,
    validatorAssertions: validatorOutput.assertions,
    modelChecks: modelFile.value.checks,
    model: { path: rel(MODEL_PATH), bytes: modelFile.bytes.length, sha256: sha256(modelFile.bytes) },
    validation: { path: rel(VALIDATION_PATH), bytes: validationFile.bytes.length, sha256: sha256(validationFile.bytes) },
    counts: { markets: modelFile.value.markets.length, positionFixtures: fixtures, semanticSections: SEMANTIC_SECTIONS.length },
    semanticSectionsCompared: SEMANTIC_SECTIONS,
    conclusions: { admittedFormulaExtraExpiryDiscontinuity: false, timestampOnlyMorphoDeficit: "unknown",
      deployedEndToEndExpiryBehavior: "unknown", protocolAccountingFlaw: "unknown", routePositive: "unknown",
      executableNow: "unknown", signedActionJustified: false, forkJustified: false },
    safety: { offline: true, validatorInvoked: true, network: false, rpc: false, inventoryRead: false,
      envRead: false, keyRead: false, signing: false, transaction: false }
  };
}

function verifyExistingResult(record, expected) {
  const stable = { ...record }; delete stable.generatedAt;
  const expectedStable = { ...expected }; delete expectedStable.generatedAt;
  if (!record || typeof record.generatedAt !== "string") throw new Error("TEST_RESULT_GENERATED_AT_INVALID");
  try { assert.deepStrictEqual(stable, expectedStable); } catch (_) { throw new Error("TEST_RESULT_BINDING_MISMATCH"); }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--check", "--write-result"].includes(args[0])) throw new Error("ARGV_FORBIDDEN_USE_CHECK_OR_WRITE_RESULT");
  ok(fs.existsSync(MODEL_PATH), "model-v2-required");
  ok(fs.existsSync(VALIDATION_PATH), "validation-v2-required");
  const invoked = childProcess.spawnSync(process.execPath, [VALIDATOR, "--check"], {
    cwd: ROOT, encoding: "utf8", windowsHide: true
  });
  same(invoked.status, 0, `validator-exit:${String(invoked.stderr).slice(0, 120)}`);
  ok(typeof invoked.stdout === "string" && invoked.stdout.trim().split(/\r?\n/).length === 1, "validator-single-output-record");
  const validatorOutput = JSON.parse(invoked.stdout.trim());
  same(validatorOutput.status, "PASS", "validator-status");
  same(validatorOutput.mode, "check", "validator-mode");
  ok(Number.isSafeInteger(validatorOutput.assertions) && validatorOutput.assertions > 0, "validator-exact-count-present");
  const modelFile = canonicalRead(MODEL_PATH, "model-v2"), validationFile = canonicalRead(VALIDATION_PATH, "validation-v2");
  const model = modelFile.value, validation = validationFile.value;
  same(Object.keys(model), ["schema", "generatedAt", "status", "mode", "checks", ...SEMANTIC_SECTIONS], "model-top-level-schema");
  same(model.schema, `${NS}/model-v2`, "model-schema");
  same(validation.schema, `${NS}/validation-v2`, "validation-schema");
  same(validation.status, "PASS", "validation-status");
  same(validation.assertions, validatorOutput.assertions, "validator-assertion-binding");
  same(validation.model, { path: rel(MODEL_PATH), bytes: modelFile.bytes.length, sha256: sha256(modelFile.bytes),
    schema: model.schema, modelChecks: model.checks }, "validation-model-binding");
  same(validatorOutput.modelSha256, sha256(modelFile.bytes), "invoked-validator-model-hash");
  same(model.inputs.artifacts, validation.parentInputs, "inputs-parent-records");
  same(model.inputs.localSourceReferences, validation.localSourceReferences, "inputs-local-records");
  same(model.markets.length, validation.counts.markets, "market-count-binding");
  const fixtures = model.markets.reduce((sum, market) => sum + market.positions.length, 0);
  same(fixtures, validation.counts.positionFixtures, "fixture-count-binding");

  // Exercise every semantically material section after the validator's full
  // independent recomputation, rather than sampling four fields.
  for (const section of SEMANTIC_SECTIONS) ok(Object.hasOwn(model, section) && model[section] !== undefined, `semantic-section:${section}`);
  same(model.boundary.ordinaryPtStep, "6341958396", "boundary-ordinary-step");
  same(model.boundary.postExpiryPtStep, "0", "boundary-post-step");
  for (const market of model.markets) {
    same(market.oracle.prices.expiry, market.oracle.prices.expiryPlusOne, `post-price-flat:${market.label}`);
    same(market.oracle.postExpiryDelta, "0", `post-delta-zero:${market.label}`);
    same(market.controls.frozenNoCallStateDelta, { supplyAssets: "0", supplyShares: "0", borrowAssets: "0", borrowShares: "0" }, `frozen-control:${market.label}`);
    same(market.controls.deficitInferenceFromFrozenNoCallControl, "NOT_PERMITTED", `no-deficit-inference:${market.label}`);
    same(market.entirePtSupplyOrdinaryStepUpperBound.authority,
      "FIXED_PIN_FROZEN_FEEDS_SCENARIO_ONLY_NOT_CAPACITY_OR_AVAILABLE_COLLATERAL", `upper-bound-authority:${market.label}`);
    same(market.entirePtSupplyOrdinaryStepUpperBound.availableCollateralClaim, false, `upper-bound-no-collateral:${market.label}`);
    same(market.entirePtSupplyOrdinaryStepUpperBound.routeCapacityClaim, false, `upper-bound-no-capacity:${market.label}`);
    const labels = new Set();
    for (const fixture of market.positions) {
      ok(!labels.has(fixture.fixture), `fixture-unique:${market.label}:${fixture.fixture}`); labels.add(fixture.fixture);
      same(BigInt(fixture.actualBorrowAssetsOffsetFromThreshold),
        BigInt(fixture.actualBorrowAssetsAtFrozenState) - BigInt(fixture.expiryMinusOneMaxBorrow), `fixture-offset:${market.label}:${fixture.fixture}`);
      same(fixture.frozenStateHealth.expiry, fixture.frozenStateHealth.expiryPlusOne, `fixture-post-flat:${market.label}:${fixture.fixture}`);
    }
  }
  same(model.comparisons.discountedVsPar.sameApyPt,
    model.markets[1].params.collateralToken === model.markets[2].params.collateralToken, "same-apy-derived");
  same(model.comparisons.discountedVsPar.separateMorphoMarkets, model.markets[1].marketId !== model.markets[2].marketId, "separate-markets-derived");
  same(model.comparisons.discountedVsPar.committedConfigurationIds, {
    discountedOracle: model.markets[1].params.oracle, parOracle: model.markets[2].params.oracle,
    discountedQuoteFeed: model.markets[1].committedSourceBinding.morphoOracle.address === model.markets[1].params.oracle ?
      model.comparisons.discountedVsPar.committedConfigurationIds.discountedQuoteFeed : null,
    parQuoteFeed: model.markets[2].committedSourceBinding.morphoOracle.address === model.markets[2].params.oracle ?
      model.comparisons.discountedVsPar.committedConfigurationIds.parQuoteFeed : null
  }, "configuration-record-binding");
  same(model.comparisons.discountedVsPar.noConfigurationSwitchAtExpiry, true, "no-configuration-switch-derived");
  same(model.candidateRoutes.every((route) => route.routeComplete === "unknown" && route.conservativeNetUsd === null), true, "route-gates");
  same(model.evidence.deployedTransitionClosure.status, "UNKNOWN", "deployed-transition-gate");
  same(model.evidence.upperBound.status, "SCENARIO_ONLY", "upper-bound-gate");
  same(model.impactPath.every((entry) => entry.supported === "unknown"), true, "impact-gates");
  same(model.conclusion, {
    admittedFormulaExtraExpiryDiscontinuity: false, oracleInducedHealthyToUnhealthyInFrozenNoCallState: false,
    timestampOnlyMorphoDeficit: "unknown", deployedEndToEndExpiryBehavior: "unknown", protocolAccountingFlaw: "unknown",
    routePositive: "unknown", executableNow: "unknown", signedActionJustified: false,
    fork: { justified: false, signedAction: false }
  }, "all-conclusion-gates");
  same(model.safety, { offline: true, network: false, rpc: false, inventoryRead: false, envRead: false,
    keyRead: false, fork: false, transaction: false, signing: false, broadcast: false, productionMutation: false }, "all-safety-gates");
  ok(!JSON.stringify(model).includes("interestSensitivity") && !JSON.stringify(model).includes("timestampOnlyProtocolDeficitRawUsdc"), "removed-v1-claims");

  const coreAssertions = assertions;
  if (coreAssertions !== EXPECTED_ASSERTIONS) throw new Error(`ASSERTION_COUNT_MISMATCH:${coreAssertions}:${EXPECTED_ASSERTIONS}`);
  const record = resultRecord(modelFile, validationFile, validatorOutput, fixtures, EXPECTED_ASSERTIONS || coreAssertions);
  let publication = null;
  if (args[0] === "--write-result") publication = publishNoOverwrite(RESULT_PATH, record);
  else if (fs.existsSync(RESULT_PATH)) {
    const resultFile = canonicalRead(RESULT_PATH, "test-result-v2");
    verifyExistingResult(resultFile.value, record);
  }
  console.log(JSON.stringify({ status: "PASS", mode: args[0].slice(2), assertions: EXPECTED_ASSERTIONS || coreAssertions,
    validatorAssertions: validatorOutput.assertions, modelChecks: model.checks, markets: model.markets.length,
    positionFixtures: fixtures, semanticSections: SEMANTIC_SECTIONS.length, modelSha256: sha256(modelFile.bytes),
    routePositive: "unknown", fork: false, wrote: Boolean(publication), publication }));
}

try { main(); } catch (error) {
  console.error(JSON.stringify({ status: "FAIL", diagnostic: String(error.message || error).slice(0, 400), assertions }));
  process.exitCode = 1;
}
