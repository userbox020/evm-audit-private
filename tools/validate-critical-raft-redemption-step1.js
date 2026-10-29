#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

if (process.argv.length !== 3 || process.argv[2] !== "--check-only") {
  console.error("usage: node tools/validate-critical-raft-redemption-step1.js --check-only");
  process.exit(2);
}

const root = path.resolve(__dirname, "..");
const manifestPath = "reports/raw/fast/critical-raft-collateral-redemption-conservation-step1-manifest.json";
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function json(relative) {
  return JSON.parse(read(relative));
}

function sha256(relative) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex");
}

const classification =
  "CONDITIONAL-HIGH-SOURCE-IMPACT/CALLBACK-CROSS-ENTRY/LOCAL-ROUTE-POSITIVE/DEPLOYMENT-EXPOSURE-UNKNOWN/EXACT-BUILD-BLOCKED/NETWORK-PURITY-DEVIATION";
const positionManager = read("targets/raft/contracts/PositionManager.sol");
const indexToken = read("targets/raft/contracts/ERC20Indexable.sol");
const cappedToken = read("targets/raft/contracts/common/ERC20Capped.sol");
const splitLiquidation = read("targets/raft/contracts/SplitLiquidationCollateral.sol");
const feeCollector = read("targets/raft/contracts/FeeCollector.sol");
const wrappedManager = read("targets/raft/contracts/PositionManagerWrappedCollateralToken.sol");
const wrappedToken = read("targets/raft/contracts/WrappedCollateralToken.sol");
const interestManager = read("targets/raft/contracts/InterestRates/InterestRatePositionManager.sol");
const wbtcScript = read("targets/raft/script/ChainlinkPriceOracleWBTC.s.sol");
const wbtcTest = read("targets/raft/test/PositionManagerWBTC.t.sol");
const certoraRedeem = read("targets/raft/certora/specs/PositionManagerRedeemCollateralChecksCollateral.spec");
const mirror = read("targets/raft/audit/raft-redemption-step1/src/RaftRedemptionMirror.sol");
const callbackTests = read("targets/raft/audit/raft-redemption-step1/test/RaftCallbackMatrix.t.sol");
const directTests = read("targets/raft/audit/raft-redemption-step1/test/RaftRedemptionConservation.t.sol");
const report = read("reports/critical-raft-collateral-redemption-conservation-step1.md");
const forgeRaw = read("reports/raw/fast/critical-raft-collateral-redemption-conservation-step1-forge.txt");
const result = json("reports/raw/fast/critical-raft-collateral-redemption-conservation-step1.json");
const metadata = json("reports/raw/fast/critical-raft-collateral-redemption-conservation-step1-metadata.json");
const inbox = json("coordination/inbox/critical/2026-07-29-critical-raft-redemption-step1.json");
const manifest = json(manifestPath);

check(result.classification === classification, "result classification mismatch");
check(metadata.classification === classification, "metadata classification mismatch");
check(inbox.status === classification, "inbox classification mismatch");
check(result.gates.localSourceRoutePositive === 1, "local source route must be positive");
check(
  result.gates.operationalRoutePositive === 0 && result.gates.globalRoutePositive === 0,
  "operational/global gates must be zero"
);
check(result.gates.routePositive === 0 && result.gates.executableNow === 0, "operational gates must be zero");
check(result.gates.signedActionJustified === false && result.gates.fork === false, "sign/fork gates must be false");
check(result.gates.deploymentExposure === null, "deployment exposure must remain null");
for (const [key, value] of Object.entries(result.currentRevisionPurity)) {
  check(value === 0, `current revision purity counter nonzero: ${key}`);
}
check(result.scope.productionBytecodeEquivalence === false, "must not claim bytecode equivalence");
check(result.scope.deploymentVerified === false, "must not claim deployment verification");
check(result.scope.deploymentExposure === null, "scope deployment exposure must remain null");
check(result.severity.deployedHighClaim === false, "must not claim deployed High");
check(result.historicalNetworkPurityDeviation.notEstablished.length === 3, "historical unknowns must remain explicit");

check(positionManager.includes("uint256 newTotalDebt = raftDebtToken.totalSupply() - debtAmount;"), "outer stale target absent");
check(positionManager.includes("collateralToken.safeTransfer(feeRecipient, redemptionFee - rebate);"), "fee callback point absent");
check(positionManager.includes("_burnRTokens(msg.sender, debtAmount);"), "outer burn absent");
check(positionManager.includes("collateralToken.safeTransfer(msg.sender, collateralToRedeem - redemptionFee);"), "caller callback point absent");
check(positionManager.includes("raftDebtToken.setIndex(totalDebtForCollateral);"), "debt index write absent");
check(positionManager.includes("raftCollateralToken.setIndex(collateralToken.balanceOf(address(this)));"), "collateral index write absent");
check(
  positionManager.indexOf("collateralToken.safeTransfer(feeRecipient") <
    positionManager.indexOf("raftDebtToken.setIndex(totalDebtForCollateral)"),
  "fee interaction must precede index"
);
check(
  positionManager.indexOf("collateralToken.safeTransfer(msg.sender, collateralToRedeem - redemptionFee)") <
    positionManager.indexOf("raftDebtToken.setIndex(totalDebtForCollateral)"),
  "caller interaction must precede index"
);
check(positionManager.includes("raftDebtToken.mint(position, totalDebtChange);"), "nested debt mint source absent");
check(positionManager.includes("raftDebtToken.burn(position, debtChange);"), "nested repay source absent");
check(positionManager.includes("raftCollateralToken.burn(position, collateralChange);"), "nested withdrawal source absent");
check(positionManager.includes("_closePosition(raftCollateralToken, raftDebtToken, position, false);"), "full close source absent");
check(positionManager.includes("_updateDebtAndCollateralIndex(collateralToken, raftCollateralToken, raftDebtToken, totalDebt);"), "liquidation index source absent");
check(positionManager.includes("onlyEnabledCollateralTokenWhen(collateralToken, isDebtIncrease && debtChange > 0)"), "enabled branch gate absent");
check(positionManager.includes("function addCollateralToken("), "collateral admission source absent");
check(feeCollector.includes("function setFeeRecipient(address newFeeRecipient) external onlyOwner"), "owner fee recipient source absent");
check(indexToken.includes("backingAmount.divUp(supply)"), "index ceil source absent");
check(indexToken.includes("ERC20.totalSupply().mulDown(currentIndex())"), "reported floor source absent");
check(cappedToken.includes("if (totalSupply() + amount > cap)"), "debt cap enforcement source absent");
check(splitLiquidation.includes("uint256 public constant override MCR = 120 * MathUtils._100_PERCENT / 100;"), "120% MCR source absent");
check(splitLiquidation.includes("collateralToSendToProtocol = 0;"), "zero non-redistribution protocol fee absent");
check(positionManager.includes("collateralToken.safeTransfer(feeRecipient, collateralLiquidationFee);"), "production liquidation fee callback absent");
check(wrappedManager.includes("wrappedCollateralToken.balanceOf(address(this))"), "wrapped entire-balance sweep source absent");
check(wrappedToken.includes("super._transfer(from, to, amount);"), "ordinary wrapper transfer source absent");
check(!wrappedToken.includes("onTokenTransfer"), "wrapper unexpectedly defines recipient callback");
const interestRedeem = interestManager.slice(
  interestManager.indexOf("function redeemCollateral"),
  interestManager.indexOf("function addCollateralToken")
);
const interestThreeArgAdmission = interestManager.slice(
  interestManager.indexOf("function addCollateralToken"),
  interestManager.indexOf("// --- Helper functions ---")
);
const fiveArgAdmissionStart = positionManager.indexOf(
  "function addCollateralToken(",
  positionManager.indexOf("function addCollateralToken(") + 1
);
const fiveArgAdmission = positionManager.slice(fiveArgAdmissionStart, positionManager.indexOf("function setCollateralEnabled"));
check(interestRedeem.includes("function redeemCollateral(IERC20, uint256, uint256)"), "interest redemption override absent");
check(interestRedeem.includes("revert Unsupported();"), "interest redemption must remain unsupported");
check(interestThreeArgAdmission.includes("revert Unsupported();"), "interest three-argument admission must be unsupported");
check(fiveArgAdmission.includes("IERC20Indexable raftDebtToken_"), "five-argument admission absent");
check(fiveArgAdmission.includes("onlyOwner"), "five-argument admission must remain owner-only");
check(wbtcTest.includes("irPosman.addCollateralToken("), "WBTC five-argument admission fixture absent");
check(wbtcTest.includes("new InterestRateDebtToken("), "WBTC interest debt-token admission binding absent");
check(wbtcScript.includes("27 hours, 28, 20e16"), "WBTC 28-digit script evidence absent");
check(certoraRedeem.includes("integrityOfRaftCollateralTokenTotalSupply"), "existing Certora redemption spec absent");

check(mirror.includes("function increaseDebt"), "mirror debt increase absent");
check(mirror.includes("function repayDebt"), "mirror repay absent");
check(mirror.includes("function closePosition"), "mirror close absent");
check(mirror.includes("function withdrawCollateral"), "mirror withdrawal absent");
check(mirror.includes("function liquidate"), "mirror liquidation absent");
check(mirror.includes("Action.IncreaseDebt"), "callback action dispatch absent");
check(mirror.includes("lastIndexedDebtBacking = totalDebtForCollateral;"), "ghost debt backing absent");
check(mirror.includes("lastIndexedCollateralBacking = COLLATERAL.balanceOf(address(this));"), "ghost collateral backing absent");
const mirrorLiquidate = mirror.slice(mirror.indexOf("function liquidate"), mirror.indexOf("function fetchPrice"));
check(!mirrorLiquidate.includes("_safeTransfer(feeRecipient"), "mirror unexpectedly models zero-fee callback");

const callbackNames = [
  "testFeeHookNestedRedeemExactCorrectedDeltas",
  "testCallerHookNestedRedeemExactDeltas",
  "testFeeHookDebtMintCreatesExactUnbackedR",
  "testCallerHookDebtMintRestoresBurnedRAndCreatesExactUnbackedSupply",
  "testFeeAndCallerHookPartialRepayCreatePhantomDebtWithoutPayout",
  "testFeeAndCallerHookFullCloseResurrectDebtAsPhantomLiability",
  "testFeeAndCallerHookCollateralWithdrawalShiftLossToIncumbents",
  "testFeeAndCallerHookNonRedistributionLiquidationResurrectDebt",
  "testFeeAndCallerHookRecursiveRedeemDepthThreeAndCumulativeGap",
  "testNestedFullCloseCanFinishBelowGlobalMinimumAndInduceRedistributionEligibility",
  "testCallbackActionFailureRollsBackOuterAndNestedState",
  "testFuzzCallerHookDebtMintGap"
];
for (const name of callbackNames) check(callbackTests.includes(name), `callback test absent: ${name}`);
check(directTests.includes("testFuzzExactTransferConservation"), "direct fuzz absent");
check(directTests.includes("testRepeatedOneRawCollateralRedemptionsNeverExceedFaceValue"), "direct repeat test absent");
for (const rollbackNeedle of [
  '"base rate rollback"',
  '"fee time rollback"',
  '"caller R rollback"',
  '"fee recipient R rollback"',
  '"caller collateral rollback"',
  '"fee recipient collateral rollback"',
  '"callback actor debt rollback"',
  '"callback actor collateral rollback"',
  '"callback count rollback"'
]) {
  check(callbackTests.includes(rollbackNeedle), `rollback assertion absent: ${rollbackNeedle}`);
}

const passRows = forgeRaw.match(/^\[PASS\]/gm) || [];
check(passRows.length === 26, `expected 26 raw PASS rows, got ${passRows.length}`);
check((forgeRaw.match(/runs: 256/g) || []).length === 2, "expected two 256-run fuzz rows");
check(forgeRaw.includes("Compiling 3 files with Solc 0.8.19"), "clean compile line absent");
check(forgeRaw.includes("26 tests passed, 0 failed"), "raw aggregate test result mismatch");
check(result.tests.totalTestFunctions === 26 && result.tests.totalFuzzCases === 512, "result counts mismatch");
check(metadata.results.lint === "PASS_CLEAN", "lint result mismatch");

check(result.callbackMatrix.debtIncrease.unbackedRVersusReportedDebt === "52499999999999999865000", "debt mint gap mismatch");
check(result.callbackMatrix.debtIncrease.callerHook.acceptedValueNetR === "6625188536953243065000", "caller net mismatch");
check(result.callbackMatrix.collateralWithdrawal.actorCollateralGainVersusBaseline === "3674242424242423800", "withdraw gain mismatch");
check(result.callbackMatrix.minimumBypass.finalPhysical === "14233298616897183802", "minimum final mismatch");
check(result.correctedNestedRedeem.feeHook.feeRoleIncome === "12812500000000000000", "fee-role attribution mismatch");
check(result.split.structuralPartitionDependentFeeReduction === "20662299393049071950", "split delta mismatch");
check(report.includes("conditional local mirror results"), "mirror qualification absent");
check(report.includes("Conditional High source impact only"), "conditional severity wording absent");
check(report.includes("No repository-defined callback-capable collateral implementation was found"), "callback collateral absence qualification absent");
check(
  report.includes(
    "InterestRatePositionManager redemption and three-argument auto-index admission are unsupported; owner-only five-argument admission remains available, but redemption is still disabled."
  ),
  "interest admission/redemption qualification absent"
);
check(result.prerequisites.interestRatePositionManager.threeArgumentAutoIndexAdmission === "Unsupported", "raw three-argument admission mismatch");
check(result.prerequisites.interestRatePositionManager.fiveArgumentOwnerOnlyAdmission === "available", "raw five-argument admission mismatch");
check(result.prerequisites.interestRatePositionManager.redemptionAfterFiveArgumentAdmission === "disabled", "raw post-admission redemption mismatch");
check(report.includes("safeTransfer(feeRecipient, 0)"), "zero-value production callback disclosure absent");
check(report.includes("structural, partition-dependent fee reduction"), "split wording absent");
check(report.includes("Exact request/byte/object-retention counts are unknown"), "purity unknowns absent");
check(report.includes("A prior revision reported"), "prior-revision purity attribution absent");
check(report.includes("does not manifest the prior transcript"), "historical transcript limitation absent");

const mirrorArtifact = json("targets/raft/audit/raft-redemption-step1/out/RaftRedemptionMirror.sol/RaftRedemptionMirror.json");
const callbackArtifact = json("targets/raft/audit/raft-redemption-step1/out/RaftCallbackMatrix.t.sol/RaftCallbackMatrixTest.json");
check(mirrorArtifact.metadata.compiler.version === "0.8.19+commit.7dd6d404", "mirror compiler mismatch");
check(callbackArtifact.metadata.compiler.version === "0.8.19+commit.7dd6d404", "callback compiler mismatch");
check(mirrorArtifact.bytecode.object.length > 1000, "mirror bytecode vacuous");
check(callbackArtifact.bytecode.object.length > 1000, "callback test bytecode vacuous");

const expectedKeyHashes = {
  "targets/raft/contracts/PositionManager.sol": "d5699247fac89f0ac1b30e6410f46ae96b3ee76dcada9c2c6e9f0f234225dd68",
  "targets/raft/contracts/ERC20Indexable.sol": "7c22551fa42fa42514c99a711e7ee1246bb5ebab331ea5275bf87132b2dfb214",
  "targets/raft/contracts/Dependencies/MathUtils.sol": "e055ea529d1779b1ee713b4110664196dd2c762a14847f8a08a721ca57fdd926",
  "targets/raft/contracts/common/ERC20Capped.sol": "3d582def5eb0bb980ee478e18a101942e694ae6ab86df9da8ef9ca0d4b43fcbc",
  "targets/raft/contracts/SplitLiquidationCollateral.sol": "85e99372b97caa221a6a77e4b5ae51c915a150360ec33507d295ba1723164109",
  "targets/raft/remappings.txt": "dd2b51fab9feb477b3593570d16cef80274ef0738c91a78c779b59f3dbbd7278",
  "targets/raft/yarn.lock": "5a9da59f39345fae7cef1a5e32d8428df8a7e8753ccc57f085e20b934234ec26"
};
for (const [relative, expected] of Object.entries(expectedKeyHashes)) {
  check(sha256(relative) === expected, `key source hash mismatch: ${relative}`);
}

check(Array.isArray(manifest.files) && manifest.files.length >= 40, "manifest file list incomplete");
for (const row of manifest.files) {
  check(sha256(row.path) === row.sha256, `manifest hash mismatch: ${row.path}`);
}
const preimage = manifest.files.map((row) => `${row.sha256}  ${row.path}`).join("\n") + "\n";
const aggregate = crypto.createHash("sha256").update(preimage).digest("hex");
check(aggregate === manifest.aggregateSha256, "manifest aggregate mismatch");
check(manifest.aggregatePreimageFormat === "<sha256><two spaces><path><LF>", "aggregate format mismatch");

const whitespaceFiles = manifest.files.filter(
  (row) =>
    /\.(sol|js|json|md|toml|txt|spec)$/.test(row.path) &&
    (!row.path.startsWith("targets/raft/") ||
      (row.path.startsWith("targets/raft/audit/raft-redemption-step1/") && !row.path.includes("/out/")))
);
for (const row of whitespaceFiles) {
  const content = read(row.path);
  check(content.endsWith("\n"), `missing final newline: ${row.path}`);
  check(!/[ \t]+$/m.test(content), `trailing whitespace: ${row.path}`);
}

console.log(`PASS ${checks} checks; aggregate ${aggregate}`);
