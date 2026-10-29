#!/usr/bin/env node
"use strict";

const { TextDecoder } = require("node:util");
const crypto = require("node:crypto");

const SCHEMA_VERSION = "permissionless-profit-promotion/1";
const POLICY_VERSION = "2026-08-17-any-positive-conservative-net";
const OWNER = "orchestrator";
const MAX_INPUT_BYTES = 262144;
const MAX_INTEGER_DIGITS = 160;
const MAX_TEXT = 2048;
const MAX_REFS = 32;
const MAX_OTHER_COSTS = 32;
const MAX_CONVERSIONS = 64;
const MANDATORY_CATEGORIES = Object.freeze([
  "obligations", "acquisition", "unwind", "fees", "slippage", "gas",
  "financing", "latency", "competition", "uncertainty"
]);
const EVIDENCE_KEYS = Object.freeze([
  "sourceExact", "localSemantic", "reachability", "reproducibility", "liquidExtraction", "economics"
]);
const ROUTE_KEYS = Object.freeze([
  "complete", "publicActor", "acquisitionPriced", "unwindPriced", "liquidSettlement",
  "residualsResolved", "liabilitiesResolved", "conversionsResolved", "gasCoverage",
  "l1DataCoverage", "blobCoverage"
]);
const GATE_KEYS = Object.freeze([
  "sourceExact", "localSemantic", "reachability", "reproducibility", "liquidExtraction",
  "economicsEvidence", "currentBinding", "routeComplete", "publicActor", "acquisitionPriced",
  "unwindPriced", "liquidSettlement", "residualsResolved", "liabilitiesResolved",
  "conversionsResolved", "gasCoverage", "l1DataCoverage", "blobCoverage", "costBounds",
  "controlEquivalent", "noFlashPrincipal"
]);

class InputError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new InputError(code); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys, code) {
  if (!isObject(value)) fail(code);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) fail(code);
  return value;
}
function boundedString(value, code, max = MAX_TEXT, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(code);
  return value;
}
function oneOf(value, allowed, code) {
  if (typeof value !== "string" || !allowed.includes(value)) fail(code);
  return value;
}
function stringArray(value, code, max = MAX_REFS, allowEmpty = true) {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) fail(code);
  const out = value.map((item) => boundedString(item, code, 256));
  if (new Set(out).size !== out.length) fail(code);
  return out;
}

function parseInteger(value, options = {}) {
  const code = options.code || "INTEGER_INVALID";
  if (typeof value !== "string" || !/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(value)) fail(code);
  if (value.replace("-", "").length > MAX_INTEGER_DIGITS) fail(code);
  const parsed = BigInt(value);
  if (options.nonnegative && parsed < 0n) fail(code);
  if (options.positive && parsed <= 0n) fail(code);
  return parsed;
}
function abs(value) { return value < 0n ? -value : value; }
function gcd(a, b) { a = abs(a); b = abs(b); while (b !== 0n) [a, b] = [b, a % b]; return a; }
function rational(numerator, denominator = 1n) {
  if (denominator === 0n) fail("RATIONAL_DENOMINATOR_INVALID");
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  const divisor = gcd(numerator, denominator);
  return Object.freeze({ numerator: numerator / divisor, denominator: denominator / divisor });
}
function parseRational(value, options = {}) {
  const code = options.code || "RATIONAL_INVALID";
  exactKeys(value, ["numerator", "denominator"], code);
  const numerator = parseInteger(value.numerator, { code, nonnegative: options.nonnegative });
  const denominator = parseInteger(value.denominator, { code, positive: true });
  if (gcd(numerator, denominator) !== 1n) fail(code);
  return rational(numerator, denominator);
}
function addRational(a, b) { return rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator); }
function subtractRational(a, b) { return rational(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator); }
function multiplyRational(a, b) { return rational(a.numerator * b.numerator, a.denominator * b.denominator); }
function divideRational(a, b) { if (b.numerator === 0n) fail("RATIONAL_DIVIDE_BY_ZERO"); return rational(a.numerator * b.denominator, a.denominator * b.numerator); }
function compareRational(a, b) { const value = a.numerator * b.denominator - b.numerator * a.denominator; return value < 0n ? -1 : value > 0n ? 1 : 0; }
function rationalEqual(a, b) { return compareRational(a, b) === 0; }
function rationalJson(value) { return { numerator: value.numerator.toString(), denominator: value.denominator.toString() }; }

function parseAmountSet(value, code, nonnegative = false) {
  exactKeys(value, ["settlement", "native", "usd"], code);
  return {
    settlement: parseRational(value.settlement, { code, nonnegative }),
    native: parseRational(value.native, { code, nonnegative }),
    usd: parseRational(value.usd, { code, nonnegative })
  };
}
function amountSetJson(value) { return { settlement: rationalJson(value.settlement), native: rationalJson(value.native), usd: rationalJson(value.usd) }; }
function amountSetEqual(a, b) { return ["settlement", "native", "usd"].every((key) => rationalEqual(a[key], b[key])); }
function amountSetZero(value) { return ["settlement", "native", "usd"].every((key) => value[key].numerator === 0n); }
function addAmountSets(a, b) { return { settlement: addRational(a.settlement, b.settlement), native: addRational(a.native, b.native), usd: addRational(a.usd, b.usd) }; }
function subtractAmountSets(a, b) { return { settlement: subtractRational(a.settlement, b.settlement), native: subtractRational(a.native, b.native), usd: subtractRational(a.usd, b.usd) }; }
function zeroAmountSet() { const zero = rational(0n); return { settlement: zero, native: zero, usd: zero }; }

function validateClaim(value) {
  exactKeys(value, ["claimId", "title", "scope", "lane", "bindingScope"], "CLAIM_SCHEMA_INVALID");
  boundedString(value.claimId, "CLAIM_ID_INVALID", 128);
  boundedString(value.title, "CLAIM_TITLE_INVALID", 256);
  boundedString(value.scope, "CLAIM_SCOPE_INVALID", 512);
  oneOf(value.lane, ["PROFIT", "NON_PROFIT"], "CLAIM_LANE_INVALID");
  oneOf(value.bindingScope, ["deployment-bound-current", "source-local"], "CLAIM_BINDING_SCOPE_INVALID");
  return value;
}
function canonicalTime(value, code) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail(code);
  return Date.parse(value);
}
function validateBindings(value, bindingScope, evaluatedAtMs) {
  exactKeys(value, ["target", "source", "runtime"], "BINDINGS_SCHEMA_INVALID");
  exactKeys(value.target, ["chainId", "address"], "TARGET_BINDING_INVALID");
  parseInteger(value.target.chainId, { code: "TARGET_CHAIN_INVALID", positive: true });
  if (typeof value.target.address !== "string" || !/^0x[0-9a-f]{40}$/.test(value.target.address)) fail("TARGET_ADDRESS_INVALID");
  exactKeys(value.source, ["artifactId", "commitment"], "SOURCE_BINDING_INVALID");
  boundedString(value.source.artifactId, "SOURCE_ARTIFACT_INVALID", 256);
  if (typeof value.source.commitment !== "string" || !/^0x[0-9a-f]{64}$/.test(value.source.commitment)) fail("SOURCE_COMMITMENT_INVALID");
  if (bindingScope === "source-local") {
    exactKeys(value.runtime, ["bindingScope"], "RUNTIME_BINDING_INVALID");
    if (value.runtime.bindingScope !== "source-local") fail("RUNTIME_BINDING_INVALID");
    return { ...value, currentDirection: "UNKNOWN" };
  }
  if (!isObject(value.runtime) || value.runtime.bindingScope !== "deployment-bound-current") fail("RUNTIME_BINDING_INVALID");
  const unavailableKeys = ["bindingScope", "status", "directionalResult", "evidenceRefs", "rationale"];
  if (Object.keys(value.runtime).length === unavailableKeys.length) {
    exactKeys(value.runtime, unavailableKeys, "RUNTIME_BINDING_INVALID");
    oneOf(value.runtime.status, ["FAIL", "BLOCKED", "UNKNOWN"], "RUNTIME_STATUS_INVALID");
    if (value.runtime.directionalResult !== "INCONCLUSIVE") fail("RUNTIME_DIRECTION_INVALID");
    stringArray(value.runtime.evidenceRefs, "RUNTIME_EVIDENCE_REFS_INVALID", MAX_REFS, true);
    boundedString(value.runtime.rationale, "RUNTIME_RATIONALE_INVALID", MAX_TEXT);
    return { ...value, currentDirection: "UNKNOWN" };
  }
  exactKeys(value.runtime, ["bindingScope", "status", "directionalResult", "chainId", "address", "blockNumber", "blockHash", "runtimeCommitment", "finalized", "observedAt", "expiresAt", "sourceRuntimeEquivalent", "evidenceRefs"], "RUNTIME_BINDING_INVALID");
  oneOf(value.runtime.status, ["PASS", "FAIL", "BLOCKED", "UNKNOWN"], "RUNTIME_STATUS_INVALID");
  if (value.runtime.status === "PASS") oneOf(value.runtime.directionalResult, ["POSITIVE", "INCONCLUSIVE"], "RUNTIME_DIRECTION_INVALID");
  else if (value.runtime.directionalResult !== "INCONCLUSIVE") fail("RUNTIME_DIRECTION_INVALID");
  parseInteger(value.runtime.chainId, { code: "RUNTIME_CHAIN_INVALID", positive: true });
  parseInteger(value.runtime.blockNumber, { code: "RUNTIME_BLOCK_INVALID", positive: true });
  if (typeof value.runtime.address !== "string" || !/^0x[0-9a-f]{40}$/.test(value.runtime.address)) fail("RUNTIME_ADDRESS_INVALID");
  if (typeof value.runtime.blockHash !== "string" || !/^0x[0-9a-f]{64}$/.test(value.runtime.blockHash)) fail("RUNTIME_BLOCK_HASH_INVALID");
  if (typeof value.runtime.runtimeCommitment !== "string" || !/^0x[0-9a-f]{64}$/.test(value.runtime.runtimeCommitment)) fail("RUNTIME_COMMITMENT_INVALID");
  if (typeof value.runtime.finalized !== "boolean" || typeof value.runtime.sourceRuntimeEquivalent !== "boolean") fail("RUNTIME_FACT_INVALID");
  const observedAtMs = canonicalTime(value.runtime.observedAt, "RUNTIME_OBSERVED_AT_INVALID");
  const expiresAtMs = canonicalTime(value.runtime.expiresAt, "RUNTIME_EXPIRES_AT_INVALID");
  if (observedAtMs >= expiresAtMs) fail("RUNTIME_FRESHNESS_WINDOW_INVALID");
  stringArray(value.runtime.evidenceRefs, "RUNTIME_EVIDENCE_REFS_INVALID", MAX_REFS, false);
  const exactIdentity = value.target.chainId === value.runtime.chainId && value.target.address === value.runtime.address;
  const fresh = evaluatedAtMs >= observedAtMs && evaluatedAtMs < expiresAtMs;
  const positive = value.runtime.status === "PASS" && value.runtime.directionalResult === "POSITIVE" && exactIdentity
    && value.runtime.finalized && value.runtime.sourceRuntimeEquivalent && fresh;
  return { ...value, currentDirection: positive ? "POSITIVE" : "UNKNOWN" };
}
function evidenceDirection(record, key) {
  if (record.directionalResult === "n/a") return "N/A";
  if (record.status !== "PASS" || record.directionalResult === "inconclusive") return "UNKNOWN";
  if (record.directionalResult === "exact" || record.directionalResult === "supports" || record.directionalResult === "positive") return "POSITIVE";
  if (record.directionalResult === "refutes" || record.directionalResult === "negative" || record.directionalResult === "nonpositive") return "NEGATIVE";
  fail(`EVIDENCE_${key.toUpperCase()}_DIRECTION_INVALID`);
}
function validateEvidenceRecord(value, key, lane) {
  exactKeys(value, ["status", "directionalResult", "assumptions", "evidenceRefs", "assessor", "assessedAt", "rationale"], "EVIDENCE_SCHEMA_INVALID");
  oneOf(value.status, ["PASS", "FAIL", "BLOCKED", "UNKNOWN"], "EVIDENCE_STATUS_INVALID");
  const dimensions = {
    sourceExact: ["exact", "inconclusive", "n/a"],
    localSemantic: ["supports", "refutes", "inconclusive", "n/a"],
    reachability: ["positive", "negative", "inconclusive", "n/a"],
    liquidExtraction: ["positive", "negative", "inconclusive", "n/a"],
    reproducibility: ["supports", "inconclusive", "n/a"],
    economics: ["positive", "nonpositive", "inconclusive", "n/a"]
  };
  oneOf(value.directionalResult, dimensions[key], "EVIDENCE_DIRECTION_INVALID");
  if (value.directionalResult === "n/a") {
    if (lane !== "NON_PROFIT") fail("EVIDENCE_DIRECTION_INVALID");
  } else if (value.status !== "PASS" && value.directionalResult !== "inconclusive") fail("EVIDENCE_DIRECTION_INVALID");
  stringArray(value.assumptions, "EVIDENCE_ASSUMPTIONS_INVALID", MAX_REFS, true);
  stringArray(value.evidenceRefs, "EVIDENCE_REFS_INVALID", MAX_REFS, false);
  boundedString(value.assessor, "EVIDENCE_ASSESSOR_INVALID", 128);
  boundedString(value.rationale, "EVIDENCE_RATIONALE_INVALID", MAX_TEXT);
  canonicalTime(value.assessedAt, "EVIDENCE_TIME_INVALID");
  return evidenceDirection(value, key);
}
function validateEvidence(value, lane) {
  exactKeys(value, EVIDENCE_KEYS, "EVIDENCE_SET_INVALID");
  return Object.fromEntries(EVIDENCE_KEYS.map((key) => [key, validateEvidenceRecord(value[key], key, lane)]));
}
function validateRoute(value) {
  exactKeys(value, ROUTE_KEYS, "ROUTE_SCHEMA_INVALID");
  const out = {};
  for (const key of ROUTE_KEYS) {
    const allowed = ["POSITIVE", "NEGATIVE", "UNKNOWN"];
    if (["gasCoverage", "l1DataCoverage", "blobCoverage"].includes(key)) allowed.push("N/A");
    out[key] = oneOf(value[key], allowed, "ROUTE_GATE_INVALID");
  }
  return out;
}
function validateLedger(value, code) {
  exactKeys(value, ["initialCapital", "durationSeconds", "ordinaryIncentives", "finalLiquidWealth", "externalContributions", "borrowedPrincipalRevenue"], code);
  return {
    initialCapital: parseAmountSet(value.initialCapital, code, true),
    durationSeconds: parseInteger(value.durationSeconds, { code, nonnegative: true }),
    ordinaryIncentives: parseAmountSet(value.ordinaryIncentives, code, true),
    finalLiquidWealth: parseAmountSet(value.finalLiquidWealth, code, true),
    externalContributions: parseAmountSet(value.externalContributions, code, true),
    borrowedPrincipalRevenue: parseAmountSet(value.borrowedPrincipalRevenue, code, true)
  };
}
function validateCost(value, expectedCategory, other) {
  exactKeys(value, ["costId", "category", "accounting", "boundStatus", "sourceAsset", "sourceRawAmount", "settlementUpper", "nativeUpper", "usdUpper", "zeroJustification", "evidenceRefs", "overlapGroup", "sourceChargeIds"], "COST_SCHEMA_INVALID");
  boundedString(value.costId, "COST_ID_INVALID", 128);
  if (other) oneOf(value.category, ["other"], "COST_CATEGORY_INVALID");
  else if (value.category !== expectedCategory) fail("COST_CATEGORY_INVALID");
  oneOf(value.accounting, ["included-in-ledger", "additional-upper-bound"], "COST_ACCOUNTING_INVALID");
  oneOf(value.boundStatus, ["POSITIVE", "UNKNOWN"], "COST_BOUND_STATUS_INVALID");
  boundedString(value.sourceAsset, "COST_SOURCE_ASSET_INVALID", 128);
  const raw = parseInteger(value.sourceRawAmount, { code: "COST_RAW_INVALID", nonnegative: true });
  const bounds = {
    settlement: parseRational(value.settlementUpper, { code: "COST_BOUND_INVALID", nonnegative: true }),
    native: parseRational(value.nativeUpper, { code: "COST_BOUND_INVALID", nonnegative: true }),
    usd: parseRational(value.usdUpper, { code: "COST_BOUND_INVALID", nonnegative: true })
  };
  boundedString(value.zeroJustification, "COST_ZERO_JUSTIFICATION_INVALID", 512, true);
  if ((raw === 0n || Object.values(bounds).some((item) => item.numerator === 0n)) && value.zeroJustification.length === 0) fail("COST_ZERO_JUSTIFICATION_REQUIRED");
  stringArray(value.evidenceRefs, "COST_EVIDENCE_REFS_INVALID", MAX_REFS, false);
  boundedString(value.overlapGroup, "COST_OVERLAP_GROUP_INVALID", 128);
  stringArray(value.sourceChargeIds, "COST_SOURCE_CHARGE_IDS_INVALID", MAX_REFS, false);
  return { ...value, bounds };
}
function validateConversion(value) {
  exactKeys(value, ["conversionId", "sourceAsset", "sourceRawAmount", "settlementLower", "nativeLower", "usdLower", "boundStatus", "evidenceRefs"], "CONVERSION_SCHEMA_INVALID");
  boundedString(value.conversionId, "CONVERSION_ID_INVALID", 128);
  boundedString(value.sourceAsset, "CONVERSION_ASSET_INVALID", 128);
  parseInteger(value.sourceRawAmount, { code: "CONVERSION_RAW_INVALID", nonnegative: true });
  const bounds = {
    settlement: parseRational(value.settlementLower, { code: "CONVERSION_BOUND_INVALID", nonnegative: true }),
    native: parseRational(value.nativeLower, { code: "CONVERSION_BOUND_INVALID", nonnegative: true }),
    usd: parseRational(value.usdLower, { code: "CONVERSION_BOUND_INVALID", nonnegative: true })
  };
  oneOf(value.boundStatus, ["POSITIVE", "UNKNOWN"], "CONVERSION_STATUS_INVALID");
  stringArray(value.evidenceRefs, "CONVERSION_REFS_INVALID", MAX_REFS, false);
  return { ...value, bounds };
}
function validateEconomics(value) {
  exactKeys(value, ["settlementAsset", "candidateLedger", "controlLedger", "grossLower", "mandatoryCosts", "otherCosts", "conversions", "peakCapital"], "ECONOMICS_SCHEMA_INVALID");
  boundedString(value.settlementAsset, "SETTLEMENT_ASSET_INVALID", 128);
  const candidate = validateLedger(value.candidateLedger, "CANDIDATE_LEDGER_INVALID");
  const control = validateLedger(value.controlLedger, "CONTROL_LEDGER_INVALID");
  const claimedGross = parseAmountSet(value.grossLower, "GROSS_INVALID");
  if (!Array.isArray(value.mandatoryCosts) || value.mandatoryCosts.length !== MANDATORY_CATEGORIES.length) fail("MANDATORY_COSTS_INVALID");
  if (!Array.isArray(value.otherCosts) || value.otherCosts.length > MAX_OTHER_COSTS) fail("OTHER_COSTS_INVALID");
  if (!Array.isArray(value.conversions) || value.conversions.length > MAX_CONVERSIONS) fail("CONVERSIONS_INVALID");
  const byCategory = new Map();
  for (const item of value.mandatoryCosts) {
    if (!isObject(item) || typeof item.category !== "string" || byCategory.has(item.category)) fail("MANDATORY_COSTS_INVALID");
    byCategory.set(item.category, item);
  }
  if (byCategory.size !== MANDATORY_CATEGORIES.length || MANDATORY_CATEGORIES.some((key) => !byCategory.has(key))) fail("MANDATORY_COSTS_INVALID");
  const costs = MANDATORY_CATEGORIES.map((key) => validateCost(byCategory.get(key), key, false));
  costs.push(...value.otherCosts.map((item) => validateCost(item, "other", true)));
  const costIds = new Set(), sourceChargeIds = new Set();
  for (const cost of costs) {
    if (costIds.has(cost.costId)) fail("DUPLICATE_COST_ACCOUNTING");
    costIds.add(cost.costId);
    for (const chargeId of cost.sourceChargeIds) {
      if (sourceChargeIds.has(chargeId)) fail("DUPLICATE_SOURCE_CHARGE_ALLOCATION");
      sourceChargeIds.add(chargeId);
    }
  }
  const conversions = value.conversions.map(validateConversion), conversionIds = new Set();
  for (const conversion of conversions) { if (conversionIds.has(conversion.conversionId)) fail("DUPLICATE_CONVERSION"); conversionIds.add(conversion.conversionId); }
  const peakCapital = parseAmountSet(value.peakCapital, "PEAK_CAPITAL_INVALID", true);
  const gross = subtractAmountSets(subtractAmountSets(candidate.finalLiquidWealth, candidate.externalContributions), control.finalLiquidWealth);
  if (!amountSetEqual(gross, claimedGross)) fail("GROSS_RECONCILIATION_INVALID");
  let costUpper = zeroAmountSet();
  for (const cost of costs) if (cost.accounting === "additional-upper-bound") costUpper = addAmountSets(costUpper, cost.bounds);
  const net = subtractAmountSets(gross, costUpper);
  return { settlementAsset: value.settlementAsset, candidate, control, gross, costs, conversions, peakCapital, costUpper, net };
}

function gateObject(evidence, bindings, route, economics) {
  const controlEquivalent = amountSetEqual(economics.candidate.initialCapital, economics.control.initialCapital)
    && economics.candidate.durationSeconds === economics.control.durationSeconds
    && amountSetEqual(economics.candidate.ordinaryIncentives, economics.control.ordinaryIncentives)
    && amountSetZero(economics.control.externalContributions);
  const noFlash = amountSetZero(economics.candidate.borrowedPrincipalRevenue) && amountSetZero(economics.control.borrowedPrincipalRevenue);
  const costBounds = economics.costs.every((cost) => cost.boundStatus === "POSITIVE") ? "POSITIVE" : "UNKNOWN";
  const sourceDirection = bindings.runtime.bindingScope === "deployment-bound-current" && bindings.currentDirection !== "POSITIVE"
    ? "UNKNOWN" : evidence.sourceExact;
  return {
    sourceExact: sourceDirection,
    localSemantic: evidence.localSemantic,
    reachability: evidence.reachability,
    reproducibility: evidence.reproducibility,
    liquidExtraction: evidence.liquidExtraction,
    economicsEvidence: evidence.economics,
    currentBinding: bindings.currentDirection,
    routeComplete: route.complete,
    publicActor: route.publicActor,
    acquisitionPriced: route.acquisitionPriced,
    unwindPriced: route.unwindPriced,
    liquidSettlement: route.liquidSettlement,
    residualsResolved: route.residualsResolved,
    liabilitiesResolved: route.liabilitiesResolved,
    conversionsResolved: route.conversionsResolved,
    gasCoverage: route.gasCoverage,
    l1DataCoverage: route.l1DataCoverage,
    blobCoverage: route.blobCoverage,
    costBounds,
    controlEquivalent: controlEquivalent ? "POSITIVE" : "NEGATIVE",
    noFlashPrincipal: noFlash ? "POSITIVE" : "NEGATIVE"
  };
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
function ledgerJson(value) {
  return {
    initialCapital: amountSetJson(value.initialCapital),
    durationSeconds: value.durationSeconds.toString(),
    ordinaryIncentives: amountSetJson(value.ordinaryIncentives),
    finalLiquidWealth: amountSetJson(value.finalLiquidWealth),
    externalContributions: amountSetJson(value.externalContributions),
    borrowedPrincipalRevenue: amountSetJson(value.borrowedPrincipalRevenue)
  };
}
function costJson(cost) {
  return {
    costId: cost.costId, category: cost.category, accounting: cost.accounting, boundStatus: cost.boundStatus,
    sourceAsset: cost.sourceAsset, sourceRawAmount: cost.sourceRawAmount,
    settlementUpper: rationalJson(cost.bounds.settlement), nativeUpper: rationalJson(cost.bounds.native), usdUpper: rationalJson(cost.bounds.usd),
    zeroJustification: cost.zeroJustification, evidenceRefs: [...cost.evidenceRefs].sort(), overlapGroup: cost.overlapGroup,
    sourceChargeIds: [...cost.sourceChargeIds].sort()
  };
}
function conversionJson(conversion) {
  return {
    conversionId: conversion.conversionId, sourceAsset: conversion.sourceAsset, sourceRawAmount: conversion.sourceRawAmount,
    settlementLower: rationalJson(conversion.bounds.settlement), nativeLower: rationalJson(conversion.bounds.native), usdLower: rationalJson(conversion.bounds.usd),
    boundStatus: conversion.boundStatus, evidenceRefs: [...conversion.evidenceRefs].sort()
  };
}
function canonicalLedger(economics) {
  return {
    settlementAsset: economics.settlementAsset,
    candidateLedger: ledgerJson(economics.candidate),
    controlLedger: ledgerJson(economics.control),
    grossLower: amountSetJson(economics.gross),
    costLedger: economics.costs.map(costJson).sort((a, b) => a.costId < b.costId ? -1 : a.costId > b.costId ? 1 : 0),
    conversions: economics.conversions.map(conversionJson).sort((a, b) => a.conversionId < b.conversionId ? -1 : a.conversionId > b.conversionId ? 1 : 0),
    peakCapital: amountSetJson(economics.peakCapital)
  };
}
function outputEconomics(economics) {
  let netBps;
  if (economics.peakCapital.usd.numerator === 0n) netBps = { status: "UNDEFINED_ZERO_PEAK_CAPITAL", value: "N/A" };
  else netBps = { status: "DEFINED", value: rationalJson(divideRational(multiplyRational(economics.net.usd, rational(10000n)), economics.peakCapital.usd)) };
  const ledger = canonicalLedger(economics);
  return {
    grossLower: amountSetJson(economics.gross),
    additionalCostUpper: amountSetJson(economics.costUpper),
    netLower: amountSetJson(economics.net),
    netBps,
    peakCapitalUsd: rationalJson(economics.peakCapital.usd),
    costLedger: ledger.costLedger,
    conversions: ledger.conversions,
    ledgerSha256: crypto.createHash("sha256").update(JSON.stringify(stableValue(ledger))).digest("hex"),
    evidenceRefs: [...economics.ledgerEvidenceRefs].sort()
  };
}
function makeOutput(gates, economics, routePositive, routeDisposition, eligibility, reasons) {
  return {
    schemaVersion: SCHEMA_VERSION,
    inputStatus: "VALID",
    gates,
    economics: outputEconomics(economics),
    routePositive,
    routeDisposition,
    promotionStatus: { eligibility, automaticPromotion: false, owner: OWNER },
    reasonCodes: [...new Set(reasons)].sort(),
    validation: { valid: true, policyVersion: POLICY_VERSION, bindingScope: economics.bindingScope, automaticPromotion: false, owner: OWNER }
  };
}
function unresolvedReasons(gates, economics) {
  const reasons = [];
  for (const key of ["sourceExact", "localSemantic", "reachability", "reproducibility", "liquidExtraction"]) {
    if (gates[key] === "UNKNOWN") reasons.push(`EVIDENCE_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}_UNKNOWN`);
    if (gates[key] === "NEGATIVE") reasons.push("BOUNDED_NEGATIVE_NOT_REPRODUCED");
  }
  if (gates.economicsEvidence !== "POSITIVE") reasons.push("ECONOMICS_EVIDENCE_UNKNOWN");
  if (!["POSITIVE", "N/A"].includes(gates.currentBinding)) reasons.push("STALE_OR_UNRESOLVED_CURRENT_BINDING");
  const routeMap = {
    routeComplete: "ROUTE_COMPLETENESS_UNRESOLVED", publicActor: "PUBLIC_ACTOR_UNRESOLVED",
    acquisitionPriced: "ACQUISITION_UNPRICED", unwindPriced: "UNWIND_UNPRICED",
    liquidSettlement: "LIQUID_SETTLEMENT_UNRESOLVED", residualsResolved: "RESIDUALS_UNRESOLVED",
    liabilitiesResolved: "LIABILITIES_UNRESOLVED", conversionsResolved: "CONVERSIONS_UNRESOLVED",
    gasCoverage: "GAS_GAP_UNRESOLVED", l1DataCoverage: "L1_DATA_GAP_UNRESOLVED", blobCoverage: "BLOB_GAP_UNRESOLVED"
  };
  for (const [key, code] of Object.entries(routeMap)) if (!["POSITIVE", "N/A"].includes(gates[key])) reasons.push(code);
  if (gates.costBounds !== "POSITIVE") reasons.push("COST_BOUND_UNRESOLVED");
  if (economics.conversions.some((item) => item.boundStatus !== "POSITIVE")) reasons.push("CONVERSION_BOUND_UNRESOLVED");
  if (gates.controlEquivalent !== "POSITIVE") reasons.push("CONTROL_NOT_EQUIVALENT");
  if (gates.noFlashPrincipal !== "POSITIVE") reasons.push("FLASH_OR_BORROWED_PRINCIPAL_AS_REVENUE");
  return reasons;
}
function evaluate(input) {
  let byteLength;
  try { byteLength = Buffer.byteLength(JSON.stringify(input), "utf8"); } catch { fail("INPUT_NOT_JSON_VALUE"); }
  if (byteLength > MAX_INPUT_BYTES) fail("INPUT_TOO_LARGE");
  exactKeys(input, ["schemaVersion", "policyVersion", "evaluatedAt", "claim", "bindings", "evidence", "route", "economics"], "INPUT_SCHEMA_INVALID");
  if (input.schemaVersion !== SCHEMA_VERSION) fail("SCHEMA_VERSION_INVALID");
  if (input.policyVersion !== POLICY_VERSION) fail("POLICY_VERSION_INVALID");
  const evaluatedAtMs = canonicalTime(input.evaluatedAt, "EVALUATION_TIME_INVALID");
  const claim = validateClaim(input.claim), bindings = validateBindings(input.bindings, claim.bindingScope, evaluatedAtMs), evidence = validateEvidence(input.evidence, claim.lane), route = validateRoute(input.route), economics = validateEconomics(input.economics);
  economics.bindingScope = claim.bindingScope;
  economics.ledgerEvidenceRefs = [...input.evidence.economics.evidenceRefs];
  const gates = gateObject(evidence, bindings, route, economics);
  if (claim.lane === "NON_PROFIT") return makeOutput(gates, economics, "n/a", "N/A", "N_A_NON_PROFIT_LANE", ["N_A_NON_PROFIT_LANE"]);
  if (claim.bindingScope === "source-local") return makeOutput(gates, economics, "unknown", "UNKNOWN", "WATCH_INCOMPLETE", ["SOURCE_LOCAL_SCOPE_NOT_CURRENT_DEPLOYMENT"]);
  const grossNonpositive = ["settlement", "native", "usd"].some((key) => compareRational(economics.gross[key], rational(0n)) <= 0);
  const boundedEvidenceNegative = ["localSemantic", "reachability", "liquidExtraction"].filter((key) => gates[key] === "NEGATIVE");
  const reproduciblyBoundedNegative = gates.reproducibility === "POSITIVE" ? boundedEvidenceNegative : [];
  const economicsNonpositive = gates.economicsEvidence === "NEGATIVE";
  if (grossNonpositive || economicsNonpositive || reproduciblyBoundedNegative.length > 0) {
    const reasons = [];
    if (grossNonpositive) reasons.push("CONSERVATIVE_GROSS_NONPOSITIVE");
    if (economicsNonpositive) reasons.push("ECONOMICS_EVIDENCE_BOUNDED_NONPOSITIVE");
    for (const key of reproduciblyBoundedNegative) reasons.push(`EVIDENCE_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}_BOUNDED_NEGATIVE`);
    return makeOutput(gates, economics, "false", "NEGATIVE", "ROUTE_NEGATIVE_BOUNDED", reasons);
  }
  const unresolved = unresolvedReasons(gates, economics);
  if (unresolved.length > 0) return makeOutput(gates, economics, "unknown", "UNKNOWN", "WATCH_INCOMPLETE", unresolved);
  const netPositive = ["settlement", "native", "usd"].every((key) => compareRational(economics.net[key], rational(0n)) > 0);
  if (!netPositive) return makeOutput(gates, economics, "false", "NEGATIVE", "WATCH_NET_NONPOSITIVE", ["CONSERVATIVE_NET_NONPOSITIVE"]);
  return makeOutput(gates, economics, "true", "POSITIVE", "ELIGIBLE_FOR_ORCHESTRATOR_PROMOTION", ["ALL_GATES_TRUE_CONSERVATIVE_NET_POSITIVE"]);
}

function unknownGates() { return Object.fromEntries(GATE_KEYS.map((key) => [key, "UNKNOWN"])); }
function invalidOutput(error) {
  const code = error instanceof InputError && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "INVALID_INPUT";
  return {
    schemaVersion: SCHEMA_VERSION,
    inputStatus: "INVALID_INPUT",
    gates: unknownGates(),
    economics: { grossLower: "N/A", additionalCostUpper: "N/A", netLower: "N/A", netBps: { status: "N/A", value: "N/A" }, peakCapitalUsd: "N/A", costLedger: "N/A", conversions: "N/A", ledgerSha256: "N/A", evidenceRefs: "N/A" },
    routePositive: "unknown",
    routeDisposition: "UNKNOWN",
    promotionStatus: { eligibility: "INVALID_INPUT", automaticPromotion: false, owner: OWNER },
    reasonCodes: [code],
    validation: { valid: false, policyVersion: POLICY_VERSION, bindingScope: "UNKNOWN", automaticPromotion: false, owner: OWNER }
  };
}
function canonicalJson(value) { return JSON.stringify(value); }
function evaluateSafe(input) { try { return evaluate(input); } catch (error) { return invalidOutput(error); } }

function runCli() {
  if (process.argv.length !== 2) { process.stdout.write(`${canonicalJson(invalidOutput(new InputError("CLI_ARGUMENTS_INVALID")))}\n`); process.exitCode = 1; return; }
  const chunks = []; let bytes = 0, finished = false;
  const finishInvalid = (error) => { if (finished) return; finished = true; process.stdout.write(`${canonicalJson(invalidOutput(error))}\n`); process.exitCode = 1; };
  process.stdin.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_INPUT_BYTES) { chunks.push(chunk); return; }
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
    process.stdin.removeAllListeners("end");
    process.stdin.removeAllListeners("error");
    finishInvalid(new InputError("INPUT_TOO_LARGE"));
    process.stdin.destroy();
  });
  process.stdin.on("error", () => finishInvalid(new InputError("STDIN_READ_INVALID")));
  process.stdin.on("end", () => {
    if (finished) return;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      const value = JSON.parse(text);
      const result = evaluate(value);
      finished = true;
      process.stdout.write(`${canonicalJson(result)}\n`);
    } catch (error) { finishInvalid(error); }
  });
}

if (require.main === module) runCli();
module.exports = Object.freeze({
  SCHEMA_VERSION, POLICY_VERSION, OWNER, MAX_INPUT_BYTES, MANDATORY_CATEGORIES,
  InputError, parseInteger, parseRational, rational, addRational, subtractRational,
  multiplyRational, divideRational, compareRational, rationalJson, canonicalJson,
  evaluate, evaluateSafe, invalidOutput
});
