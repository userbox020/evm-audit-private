#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildBinding } = require("./termmax-v2-ethers-runtime-binding");

const ROOT = path.resolve(__dirname, "..");
const SUPPLEMENT = path.join(ROOT, "reports", "raw", "fast", "critical-termmax-v2-router-sweep-step2-r2-supplement.json");
const ECON = path.join(ROOT, "reports", "raw", "fast", "critical-termmax-v2-router-sweep-step2-economics-r2.json");
let checks = 0;
function check(ok, message) { if (!ok) throw new Error(message); checks++; }
function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function noLeaks(value, key = "") {
  check(!/^(?:url|urls|domain|domains|provider|providers|credential|credentials|header|headers|inventory|rawresponse|rawresponses)$/i.test(key), `forbidden key ${key}`);
  if (typeof value === "string") {
    check(!/https?:\/\//i.test(value), "URL leak");
    check(!/[a-z0-9-]+\.(?:com|io|org|net|xyz|app|dev|cloud)\b/i.test(value), "domain leak");
  } else if (Array.isArray(value)) for (const item of value) noLeaks(item, key);
  else if (value && typeof value === "object") for (const [k, item] of Object.entries(value)) noLeaks(item, k);
}
function sha(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function main() {
  const s = json(SUPPLEMENT), e = json(ECON);
  noLeaks(s); noLeaks(e);
  check(s.schema === "termmax-v2-router-sweep-step2-r2-supplement/v1", "supplement schema");
  check(s.classification.includes("ECONOMICS-INCOMPLETE"), "classification");
  check(s.authorization.rpcCallsUsed === 124, "bounded calls");
  for (const k of ["networkWrites", "transactions", "signing", "broadcasts", "mutations", "forks"]) check(s.authorization[k] === 0, `zero ${k}`);
  check(s.authorization.privateOwnersEnumerated === false && s.authorization.persistedRpcPayloads === false, "privacy");
  check(s.pin.chainId === 8453 && s.pin.number === "49263536" && s.pin.terminalValidFamilies === 2 && s.pin.terminalRecheck, "pin");
  check(s.pin.baseFeePerGasWei === "5000000", "base fee");
  check(s.pin.medianPriorityFeeScenarioWei === "1000000" && s.pin.priorityFeeFamilyAgreement, "priority scenario");
  check(s.exactRoute.calldataBytes === 452 && s.exactRoute.calldataZeroBytes === 418 && s.exactRoute.calldataNonzeroBytes === 34, "calldata counts");
  check(s.l2IntrinsicLowerBound.gas === "23216", "intrinsic gas");
  check(BigInt(s.l2IntrinsicLowerBound.gas) === 21000n + 4n * 418n + 16n * 34n, "intrinsic formula");
  check(BigInt(s.l2IntrinsicLowerBound.baseFeeOnlyCostWei) === 23216n * 5000000n, "base cost");
  check(BigInt(s.l2IntrinsicLowerBound.basePlusPriorityScenarioCostWei) === 23216n * 6000000n, "priority cost");
  check(s.exactRoute.priorEstimateGasObserved === "76604" && s.exactRoute.priorEstimateUsedAsMinimum === false, "estimate correction");
  check(s.l1DataFee.contract === "0x420000000000000000000000000000000000000f", "GPO");
  check(s.l1DataFee.isEcotone && s.l1DataFee.isFjord, "GPO regime");
  for (const key of ["getL1Fee", "getL1GasUsed", "getL1FeeUpperBound"]) check(s.l1DataFee[key].attempted && s.l1DataFee[key].successFamilies === 2 && s.l1DataFee[key].familyAgreement, `${key} agreement`);
  check(s.l1DataFee.getL1Fee.wei === "807681538", "L1 fee");
  check(s.l1DataFee.getL1GasUsed.gas === "1834", "L1 gas");
  check(s.l1DataFee.getL1FeeUpperBound.wei === "3117182340", "L1 upper");
  check(s.l1DataFee.provenMinimumL1FeeWei === null, "no false L1 minimum");
  check(s.economics.grossUsd === "0.00064314840392" && s.economics.standaloneSpecifiedEnvelopeNetUsd === "0.00041917746269", "scenario economics");
  check(s.economics.standaloneProvenMinimumTotalCostWei === null && s.economics.standaloneNetStatus.startsWith("incomplete"), "standalone incomplete");
  check(s.economics.marginalOrBatchedIncrementalCostWei === null && s.economics.marginalOrBatchedNetUsd === null && s.economics.marginalOrBatchedNetStatus.startsWith("incomplete"), "marginal incomplete");
  check(s.recipientRouterDeltaTrace.familiesAttempted === 2 && s.recipientRouterDeltaTrace.sanitizedSummaryAgreement, "trace agreement");
  check(s.recipientRouterDeltaTrace.recipientDeltaProven && s.recipientRouterDeltaTrace.recipientDelta === "1" && s.recipientRouterDeltaTrace.routerDelta === "-1", "trace deltas");
  for (const row of s.recipientRouterDeltaTrace.rows) {
    check(row.debugTraceAttempted && row.debugTraceSuccess && row.status === "sanitized-trace-summary", "trace success");
    check(row.summary.mappedBalanceDelta.mappingSlot === 9, "mapping slot");
    check(row.summary.mappedBalanceDelta.routerBefore === "1" && row.summary.mappedBalanceDelta.routerAfter === "0", "router trace");
    check(row.summary.mappedBalanceDelta.recipientBefore === "7414" && row.summary.mappedBalanceDelta.recipientAfter === "7415", "recipient trace");
  }
  check(s.allowances.candidateMarkets === 9 && s.allowances.candidatePairs === 18 && s.allowances.attemptedPairs === 18, "allowance denominator");
  check(s.allowances.successfulAgreedPairs === 18 && s.allowances.rows.length === 18, "all pair success");
  check(s.allowances.nonzeroAllowancePairs === 0 && s.allowances.nonzeroAllowanceAndBalancePairs === 0, "allowance zeros");
  const unique = new Set();
  for (const row of s.allowances.rows) {
    check(row.attempted && row.familiesAttempted === 2, "pair attempted");
    check(row.allowanceCallSuccessFamilies === 2 && row.balanceCallSuccessFamilies === 2 && row.familyAgreement, "pair agreement");
    check(row.allowance === "0" && row.routerTokenBalance === "0" && row.status === "success-agreed", "pair zero status");
    unique.add(`${row.market}:${row.gt}:${row.token}:${row.kind}`);
  }
  check(unique.size === 18, "unique pairs");
  check(s.correctedAggregates.terminalValidStrictRuntimeUnpaused === 4 && s.correctedAggregates.terminalValidTwoFamilyStrictRuntimeUnpaused === 4, "correct terminal aggregate");
  check(s.correctedAggregates.preTerminalBeraRows === 1, "Bera separate");
  check(s.correctedAggregates.blockedChains.length === 4 && s.correctedAggregates.blockedChains.every((x) => x.routePositive === null && x.economics === null), "blocked nulls");
  const bnb = s.correctedAggregates.tokenUniverseByChain.find((x) => x.chainId === 56);
  check(bnb.boundedTokenRows === 0 && bnb.scanCompletedSingleFamily === false && bnb.completeness === false && bnb.caveat.includes("not an all-zero"), "BNB correction");
  for (const id of [1, 8453]) {
    const row = s.correctedAggregates.tokenUniverseByChain.find((x) => x.chainId === id);
    check(row.scanCompletedSingleFamily === true && row.completeness === "unknown", "single-family unknown completeness");
  }
  const runtime = buildBinding();
  check(JSON.stringify(runtime) === JSON.stringify(s.runtimeDependencyBinding), "runtime dependency binding");
  check(runtime.loadedFileCount === 169 && runtime.loadedFilesAggregateSha256 === "5699024bd2f7bad8651705fb583b4b2a88209b6c3b10bd5394687afeaefe7602", "runtime aggregate");
  check(runtime.packageLockSha256 === "1eccf9bfc6f868dc5017051c36044e671942d833b68de7bf72403eea41482ed5", "package lock");
  check(e.classification.includes("ECONOMICS-INCOMPLETE") && e.standalone.netStatus === "incomplete" && e.marginalOrBatched.netStatus === "incomplete", "economics successor");
  check(e.predecessorStatus === "superseded-non-governing-historical-estimate-based-scenario", "predecessor status explicit");
  check(s.gates.localSourceRoutePositive === 1 && s.gates.operationalGlobalRoutePositive === 0 && s.gates.executableNow === 0 && !s.gates.standaloneRouteNegativeProven && !s.gates.marginalOrBatchedRouteNegativeProven, "gates");
  console.log(JSON.stringify({ status: "PASS", checksPassed: checks, pairs: s.allowances.rows.length, traceDeltaProven: s.recipientRouterDeltaTrace.recipientDeltaProven, intrinsicGas: s.l2IntrinsicLowerBound.gas }));
}
try { main(); } catch (error) { console.error(JSON.stringify({ status: "FAIL", reason: String(error.message || "unknown") })); process.exit(1); }
