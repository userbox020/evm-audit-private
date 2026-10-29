#!/usr/bin/env node
"use strict";
const fs = require("fs"); const path = require("path"); const ROOT = path.resolve(__dirname, ".."); let passed = 0;
function t(v, n) { if (!v) throw new Error(n); passed++; }
function compare(a, b) { if (a === null && b === null) return { status: "null", value: null }; if (a === null || b === null) return { status: "disagreement", value: null }; return JSON.stringify(a) === JSON.stringify(b) ? { status: "agree", value: a } : { status: "disagreement", value: null }; }
function bool(r) { return r.status === "agree" && Array.isArray(r.value) && typeof r.value[0] === "boolean" ? r.value[0] : null; }
function opt(gain, fixed, marginal, max) { if ([gain, fixed, marginal, max].some(x => x === null)) return null; let best = null; for (let n = 1; n <= max; n++) { const score = BigInt(n) * gain - fixed - BigInt(n) * marginal; if (best === null || score > best.score) best = { n, score }; } return best; }
function verifyArgs(market, redeemer, amount) { return { caller: market, market, redeemer, underlyingAmountRaw: String(amount), vTokenAmountRaw: "1" }; }
t(bool(compare([true], [true])) === true, "true"); t(bool(compare([false], [false])) === false, "false"); t(bool(compare(null, null)) === null, "null"); t(bool(compare([true], [false])) === null, "disagreement"); t(bool(compare([true], null)) === null, "one-null");
t(opt(null, 1n, 1n, 10) === null, "null optimization"); t(opt(1n, 10n, 2n, 10).n === 1, "best n1"); t(opt(5n, 10n, 2n, 10).n === 10, "best max");
const R = 201711847160308800992378275n, O = 10n ** 18n, A = (2n * R - 1n) / O;
t(A === 403423694n, "selected amount"); t((R + O - 1n) / O === 201711848n, "ceil bound"); t(A - R / O === 201711847n, "selected excess");
t(verifyArgs("market", "redeemer", A).underlyingAmountRaw === "403423694", "verify underlying amount"); t(verifyArgs("market", "redeemer", A).vTokenAmountRaw === "1", "verify vToken amount"); t(verifyArgs("market", "redeemer", A).caller === "market" && verifyArgs("market", "redeemer", A).market === "market", "verify caller market");
for (let i = 1n; i <= 512n; i++) { const r = i * 100000000000003n; const a = i * 7919n + 1n; const b = a * O / r; t(a * O - b * r < r, `bound ${i}`); }
if (process.argv.includes("--capture")) {
  const cap = JSON.parse(fs.readFileSync(path.join(ROOT, "reports/raw/fast/critical-venus-vtoken-underburn-step2-r3-capture.json")));
  t(cap.authorization.successfulCaptures === 2 && cap.authorization.networkCaptureAttemptsThisRevision === 4, "capture accounting"); t(cap.terminal.match === true, "terminal"); t(cap.runtimeInventory.allCoreMarkets === 52, "market count");
  t(cap.runtimeInventory.exactOrNormalizedFloor === 8 && cap.exactFloorMarkets.length === 8, "exact count"); t(cap.runtimeInventory.affectedNull === 44, "unknown count");
  t(cap.exactFloorMarkets.every(x => [true, false, null].includes(x.state.listed)), "listed tri-state"); t(cap.exactFloorMarkets.every(x => x.delivery.marketType === "erc20" || x.delivery.marketType === "unknown"), "type tri-state");
  t(cap.vSXP.state.listed === true, "vSXP listed"); t(cap.vSXP.productionPolicy.redeemAllowed === true && cap.vSXP.productionPolicy.redeemVerifyCallSuccess === true, "vSXP policy");
  t(cap.vSXP.state.redeemPaused === false && cap.vSXP.state.transferPaused === false, "vSXP pauses"); t(cap.vSXP.delivery.deliveryQualification.startsWith("nominal-only"), "nominal delivery");
  t(cap.vSXP.acquisition.sharedVault.attribution.includes("nonwithdrawable"), "vault attribution"); t(cap.vSXP.acquisition.acquisitionStatus === "UNBOUND", "acquisition null");
  t(cap.vSXP.correctedArithmetic.conservativeCeilBoundRawSXP === "201711848" && cap.vSXP.correctedArithmetic.selectedIntegerExcessRawSXP === "201711847", "capture arithmetic");
  t(cap.targetedPolicyFix.attemptsThisFix === 2 && cap.targetedPolicyFix.previousAttempt.rowsAgreed === 0 && cap.targetedPolicyFix.rowsAttempted === 8 && cap.targetedPolicyFix.rowsAgreed === 8 && cap.targetedPolicyFix.observedFamilies === 2, "targeted policy fix");
  t(cap.exactFloorMarkets.every(x => x.policy.redeemVerifyTestedArguments.caller.toLowerCase() === x.vToken.toLowerCase() && x.policy.redeemVerifyTestedArguments.market.toLowerCase() === x.vToken.toLowerCase()), "verify caller market route");
  t(cap.exactFloorMarkets.every(x => x.policy.redeemVerifyTestedArguments.underlyingAmountRaw === x.arithmetic.redeemAmountRaw && x.policy.redeemVerifyTestedArguments.vTokenAmountRaw === x.arithmetic.burnRawVTokens), "verify amount route");
  t(cap.exactFloorMarkets.every(x => x.blockerRow.includes("DELIVERY_EXACT_SEMANTICS_UNBOUND")), "delivery blockers"); t(cap.exactFloorMarkets.filter(x => x.blockerRow.includes("INSUFFICIENT_CASH_FOR_ONE_SHARE")).map(x => x.symbol).join(",") === "vTUSDOLD", "cash blocker");
  t(cap.postCaptureOfflineDerivation.applied === true && cap.postCaptureOfflineDerivation.networkReads === 0, "offline blocker derivation");
  t(cap.vSXP.economics.bestExecutableN === null && cap.vSXP.economics.currentNet === null, "economics null"); t(Object.values(cap.leakGuard).every(x => x === 0), "leak guard");
}
console.log(`PASS ${passed}/${passed} R3 fixtures; 512 formula cases; mode=${process.argv.includes("--capture") ? "capture" : "offline"}; no files written`);
