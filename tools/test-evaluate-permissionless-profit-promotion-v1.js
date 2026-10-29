#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const path = require("node:path");
const E = require("./evaluate-permissionless-profit-promotion-v1.js");

let tests = 0;
function test(name, fn) { try { fn(); tests++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }
function q(n, d = 1) { return { numerator: String(n), denominator: String(d) }; }
function amounts(n, d = 1) { return { settlement: q(n, d), native: q(n, d), usd: q(n, d) }; }
function evidence(status = "PASS", directionalResult = "supports") {
  return { status, directionalResult, assumptions: [], evidenceRefs: ["local:test"], assessor: "defensive-review", assessedAt: "2026-08-30T00:00:00.000Z", rationale: "Bounded local evidence." };
}
function cost(category, n = 0, accounting = "additional-upper-bound") {
  return {
    costId: `cost-${category}`, category, accounting, boundStatus: "POSITIVE", sourceAsset: "USD", sourceRawAmount: String(n),
    settlementUpper: q(n), nativeUpper: q(n), usdUpper: q(n), zeroJustification: n === 0 ? "No cost in bounded model." : "",
    evidenceRefs: ["local:cost"], overlapGroup: `overlap-${category}`, sourceChargeIds: [`charge-${category}`]
  };
}
function runtime() {
  return {
    bindingScope: "deployment-bound-current", status: "PASS", directionalResult: "POSITIVE", chainId: "1", address: `0x${"1".repeat(40)}`,
    blockNumber: "1", blockHash: `0x${"4".repeat(64)}`, runtimeCommitment: `0x${"3".repeat(64)}`, finalized: true,
    observedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T01:00:00.000Z", sourceRuntimeEquivalent: true,
    evidenceRefs: ["local:runtime"]
  };
}
function fixture() {
  return {
    schemaVersion: E.SCHEMA_VERSION,
    policyVersion: E.POLICY_VERSION,
    evaluatedAt: "2026-08-30T00:05:00.000Z",
    claim: { claimId: "claim-1", title: "Bounded candidate", scope: "target function", lane: "PROFIT", bindingScope: "deployment-bound-current" },
    bindings: {
      target: { chainId: "1", address: `0x${"1".repeat(40)}` },
      source: { artifactId: "source-1", commitment: `0x${"2".repeat(64)}` },
      runtime: runtime()
    },
    evidence: {
      sourceExact: evidence("PASS", "exact"), localSemantic: evidence("PASS", "supports"), reachability: evidence("PASS", "positive"), reproducibility: evidence("PASS", "supports"),
      liquidExtraction: evidence("PASS", "positive"), economics: evidence("PASS", "positive")
    },
    route: {
      complete: "POSITIVE", publicActor: "POSITIVE", acquisitionPriced: "POSITIVE", unwindPriced: "POSITIVE",
      liquidSettlement: "POSITIVE", residualsResolved: "POSITIVE", liabilitiesResolved: "POSITIVE", conversionsResolved: "POSITIVE",
      gasCoverage: "POSITIVE", l1DataCoverage: "N/A", blobCoverage: "N/A"
    },
    economics: {
      settlementAsset: "USD",
      candidateLedger: { initialCapital: amounts(100), durationSeconds: "60", ordinaryIncentives: amounts(0), finalLiquidWealth: amounts(102), externalContributions: amounts(0), borrowedPrincipalRevenue: amounts(0) },
      controlLedger: { initialCapital: amounts(100), durationSeconds: "60", ordinaryIncentives: amounts(0), finalLiquidWealth: amounts(100), externalContributions: amounts(0), borrowedPrincipalRevenue: amounts(0) },
      grossLower: amounts(2), mandatoryCosts: E.MANDATORY_CATEGORIES.map((category) => cost(category)), otherCosts: [], conversions: [], peakCapital: amounts(100)
    }
  };
}
function out(value) { return E.evaluateSafe(value); }
function invalid(value, code) {
  const result = out(value);
  assert.equal(result.inputStatus, "INVALID_INPUT");
  assert.equal(result.routePositive, "unknown");
  assert.equal(result.routeDisposition, "UNKNOWN");
  if (code) assert.deepEqual(result.reasonCodes, [code]);
  assert.equal(result.promotionStatus.automaticPromotion, false);
  assert.equal(result.promotionStatus.owner, "orchestrator");
}
function setCost(value, category, n, accounting = "additional-upper-bound") {
  const row = value.economics.mandatoryCosts.find((item) => item.category === category);
  Object.assign(row, { accounting, sourceRawAmount: String(n), settlementUpper: q(n), nativeUpper: q(n), usdUpper: q(n), zeroJustification: n === 0 ? "No cost." : "" });
}
function cli(input, args = []) {
  return childProcess.spawnSync(process.execPath, [path.join(__dirname, "evaluate-permissionless-profit-promotion-v1.js"), ...args], { input, encoding: null, timeout: 5000, maxBuffer: 1024 * 1024 });
}

function main() {
  test("case 1 eligible exact net one and canonical route strings", () => {
    const v = fixture(); setCost(v, "gas", 1); const r = out(v);
    assert.equal(r.routePositive, "true"); assert.equal(r.routeDisposition, "POSITIVE");
    assert.deepEqual(r.economics.netLower.usd, q(1)); assert.deepEqual(r.economics.netBps.value, q(100));
    assert(Object.values(r.gates).every((gate) => typeof gate === "string"));
  });
  test("cases 2-3 zero and negative gross", () => {
    for (const [final, gross] of [[100, 0], [99, -1]]) { const v = fixture(); v.economics.candidateLedger.finalLiquidWealth = amounts(final); v.economics.grossLower = amounts(gross); const r = out(v); assert.equal(r.routePositive, "false"); assert.equal(r.routeDisposition, "NEGATIVE"); }
  });
  test("case 4 each missing mandatory category invalid", () => {
    for (const category of E.MANDATORY_CATEGORIES) { const v = fixture(); v.economics.mandatoryCosts = v.economics.mandatoryCosts.filter((row) => row.category !== category); invalid(v, "MANDATORY_COSTS_INVALID"); }
  });
  test("case 5 unjustified zero invalid", () => { const v = fixture(); v.economics.mandatoryCosts[0].zeroJustification = ""; invalid(v, "COST_ZERO_JUSTIFICATION_REQUIRED"); });
  test("cases 6-9 valid unknown blocked fail and inconclusive evidence", () => {
    for (const [status, direction] of [["UNKNOWN", "inconclusive"], ["BLOCKED", "inconclusive"], ["FAIL", "inconclusive"], ["PASS", "inconclusive"]]) {
      const v = fixture(); v.evidence.localSemantic = evidence(status, direction); const r = out(v); assert.equal(r.gates.localSemantic, "UNKNOWN"); assert.equal(r.routePositive, "unknown"); assert.equal(r.routeDisposition, "UNKNOWN");
    }
  });
  test("case 10 reproducibly bounded negatives", () => {
    for (const [key, direction] of [["localSemantic", "refutes"], ["reachability", "negative"], ["liquidExtraction", "negative"]]) {
      const v = fixture(); v.evidence[key] = evidence("PASS", direction); const r = out(v); assert.equal(r.routePositive, "false"); assert.equal(r.routeDisposition, "NEGATIVE");
    }
  });
  test("cases 12-13 residual and liability incomplete", () => {
    for (const [key, code] of [["residualsResolved", "RESIDUALS_UNRESOLVED"], ["liabilitiesResolved", "LIABILITIES_UNRESOLVED"]]) { const v = fixture(); v.route[key] = "UNKNOWN"; const r = out(v); assert.equal(r.routePositive, "unknown"); assert(r.reasonCodes.includes(code)); }
  });
  test("case 14 duplicate atomic source charge invalid", () => {
    const v = fixture(); v.economics.mandatoryCosts[1].sourceChargeIds = [...v.economics.mandatoryCosts[0].sourceChargeIds]; v.economics.mandatoryCosts[1].category = "acquisition"; v.economics.mandatoryCosts[1].overlapGroup = "different-overlap"; invalid(v, "DUPLICATE_SOURCE_CHARGE_ALLOCATION");
  });
  test("case 15 flash principal is incomplete", () => { const v = fixture(); v.economics.candidateLedger.borrowedPrincipalRevenue = amounts(1); const r = out(v); assert.equal(r.routePositive, "unknown"); assert(r.reasonCodes.includes("FLASH_OR_BORROWED_PRINCIPAL_AS_REVENUE")); });
  test("case 16 sub-micro exact rational", () => {
    const v = fixture(); v.economics.candidateLedger.finalLiquidWealth = amounts(100000000001, 10000000000); v.economics.controlLedger.finalLiquidWealth = amounts(10); v.economics.candidateLedger.initialCapital = amounts(10); v.economics.controlLedger.initialCapital = amounts(10); v.economics.grossLower = amounts(1, 10000000000); v.economics.peakCapital = amounts(10); const r = out(v); assert.equal(r.routePositive, "true"); assert.deepEqual(r.economics.netLower.usd, q(1, 10000000000));
  });
  test("case 17 zero capital bps undefined but net positive", () => { const v = fixture(); v.economics.candidateLedger.initialCapital = amounts(0); v.economics.controlLedger.initialCapital = amounts(0); v.economics.peakCapital = amounts(0); const r = out(v); assert.equal(r.routePositive, "true"); assert.deepEqual(r.economics.netBps, { status: "UNDEFINED_ZERO_PEAK_CAPITAL", value: "N/A" }); });
  test("case 18 malformed numeric gates and policy", () => {
    const variants = []; let v = fixture(); v.economics.peakCapital.usd.numerator = 1; variants.push(v); v = fixture(); v.economics.peakCapital.usd.numerator = "01"; variants.push(v); v = fixture(); v.economics.peakCapital.usd.numerator = "1e2"; variants.push(v); v = fixture(); v.route.complete = true; variants.push(v); v = fixture(); v.policyVersion = "legacy"; variants.push(v); for (const item of variants) invalid(item);
  });
  test("net zero and negative are canonical negative", () => { for (const n of [2, 3]) { const v = fixture(); setCost(v, "gas", n); const r = out(v); assert.equal(r.routePositive, "false"); assert.equal(r.routeDisposition, "NEGATIVE"); } });
  test("included ledger cost not subtracted", () => { const v = fixture(); setCost(v, "gas", 9, "included-in-ledger"); const r = out(v); assert.deepEqual(r.economics.additionalCostUpper.usd, q(0)); assert.deepEqual(r.economics.netLower.usd, q(2)); });
  test("economics evidence is key-specific gate", () => {
    let v = fixture(); v.evidence.economics = evidence("FAIL", "inconclusive"); let r = out(v); assert.equal(r.gates.economicsEvidence, "UNKNOWN"); assert.equal(r.routePositive, "unknown");
    v = fixture(); v.evidence.economics = evidence("BLOCKED", "inconclusive"); r = out(v); assert.equal(r.gates.economicsEvidence, "UNKNOWN");
    v = fixture(); v.evidence.economics = evidence("PASS", "nonpositive"); r = out(v); assert.equal(r.gates.economicsEvidence, "NEGATIVE"); assert.equal(r.routePositive, "false"); assert.equal(r.routeDisposition, "NEGATIVE");
  });
  test("invalid evidence status-direction combinations rejected", () => {
    for (const [key, status, direction] of [["reachability", "FAIL", "negative"], ["liquidExtraction", "BLOCKED", "positive"], ["sourceExact", "PASS", "refutes"], ["sourceExact", "PASS", "negative"], ["localSemantic", "PASS", "negative"], ["reproducibility", "PASS", "negative"], ["economics", "FAIL", "positive"], ["economics", "PASS", "supports"]]) { const v = fixture(); v.evidence[key] = evidence(status, direction); invalid(v, "EVIDENCE_DIRECTION_INVALID"); }
  });
  test("negative evidence without reproducibility is unknown not false", () => { const v = fixture(); v.evidence.reachability = evidence("PASS", "negative"); v.evidence.reproducibility = evidence("FAIL", "inconclusive"); const r = out(v); assert.equal(r.routePositive, "unknown"); assert.equal(r.routeDisposition, "UNKNOWN"); });
  test("deployment binding exact positive", () => { const r = out(fixture()); assert.equal(r.gates.currentBinding, "POSITIVE"); assert.equal(r.gates.sourceExact, "POSITIVE"); assert.equal(r.routePositive, "true"); });
  test("deployment stale mismatch reorg and nonfinal evidence are unknown", () => {
    const variants = [];
    let v = fixture(); v.evaluatedAt = "2026-08-30T02:00:00.000Z"; variants.push(v);
    v = fixture(); v.evaluatedAt = v.bindings.runtime.expiresAt; variants.push(v);
    v = fixture(); v.bindings.runtime.address = `0x${"9".repeat(40)}`; variants.push(v);
    v = fixture(); v.bindings.runtime.sourceRuntimeEquivalent = false; variants.push(v);
    v = fixture(); v.bindings.runtime.finalized = false; variants.push(v);
    for (const item of variants) { const r = out(item); assert.equal(r.gates.currentBinding, "UNKNOWN"); assert.equal(r.gates.sourceExact, "UNKNOWN"); assert.equal(r.routePositive, "unknown"); }
  });
  test("missing current evidence record is valid unknown", () => {
    const v = fixture(); v.bindings.runtime = { bindingScope: "deployment-bound-current", status: "BLOCKED", directionalResult: "INCONCLUSIVE", evidenceRefs: [], rationale: "Current evidence unavailable." }; const r = out(v); assert.equal(r.inputStatus, "VALID"); assert.equal(r.gates.currentBinding, "UNKNOWN"); assert.equal(r.gates.sourceExact, "UNKNOWN");
  });
  test("positive enum alone cannot promote", () => { const v = fixture(); v.bindings.runtime = { bindingScope: "deployment-bound-current", currentStatus: "POSITIVE" }; invalid(v, "RUNTIME_BINDING_INVALID"); });
  test("malformed deployment binding is invalid", () => {
    const variants = []; let v = fixture(); v.bindings.runtime.blockNumber = "0"; variants.push(v); v = fixture(); v.bindings.runtime.blockHash = `0x${"A".repeat(64)}`; variants.push(v); v = fixture(); v.bindings.runtime.runtimeCommitment = "0x12"; variants.push(v); v = fixture(); v.bindings.source.commitment = "0x12"; variants.push(v); v = fixture(); v.bindings.runtime.observedAt = v.bindings.runtime.expiresAt; variants.push(v); v = fixture(); v.evaluatedAt = "2026-08-30"; variants.push(v); for (const item of variants) invalid(item);
  });
  test("source-local profit scope can never promote or become bounded negative", () => { for (const mode of ["positive", "economics-nonpositive", "gross-zero"]) { const v = fixture(); v.claim.bindingScope = "source-local"; v.bindings.runtime = { bindingScope: "source-local" }; if (mode === "economics-nonpositive") v.evidence.economics = evidence("PASS", "nonpositive"); if (mode === "gross-zero") { v.economics.candidateLedger.finalLiquidWealth = amounts(100); v.economics.grossLower = amounts(0); } const r = out(v); assert.equal(r.gates.currentBinding, "UNKNOWN"); assert.equal(r.gates.sourceExact, "POSITIVE"); assert.equal(r.validation.bindingScope, "source-local"); assert.equal(r.routePositive, "unknown"); assert.equal(r.routeDisposition, "UNKNOWN"); assert.equal(r.promotionStatus.eligibility, "WATCH_INCOMPLETE"); } });
  test("itemized economics ledger and commitment bind input", () => {
    const v = fixture(); v.economics.otherCosts.push({ ...cost("other", 1), costId: "cost-other-1", category: "other", sourceChargeIds: ["charge-other-1"] }); const r = out(v); assert.equal(r.economics.costLedger.length, 11); assert.equal(r.economics.ledgerSha256.length, 64); assert.deepEqual(r.economics.evidenceRefs, ["local:test"]); assert(r.economics.costLedger.every((row) => row.sourceChargeIds.length > 0));
    const changed = fixture(); changed.economics.mandatoryCosts[0].evidenceRefs = ["different:evidence"]; assert.notEqual(out(changed).economics.ledgerSha256, out(fixture()).economics.ledgerSha256);
  });
  test("shared overlap group allowed only for disjoint source charges", () => { const v = fixture(); v.economics.mandatoryCosts[1].overlapGroup = v.economics.mandatoryCosts[0].overlapGroup; v.economics.otherCosts.push({ ...cost("other"), costId: "other-a", category: "other", overlapGroup: "shared-other", sourceChargeIds: ["other-charge-a"] }, { ...cost("other"), costId: "other-b", category: "other", overlapGroup: "shared-other", sourceChargeIds: ["other-charge-b"] }); assert.equal(out(v).routePositive, "true"); v.economics.mandatoryCosts[1].sourceChargeIds = [...v.economics.mandatoryCosts[0].sourceChargeIds]; invalid(v, "DUPLICATE_SOURCE_CHARGE_ALLOCATION"); });
  test("duplicate charge bypass through other cost rejected", () => { const v = fixture(); const row = { ...cost("other"), costId: "other-id", category: "other", accounting: "included-in-ledger", overlapGroup: "new-group", sourceChargeIds: [v.economics.mandatoryCosts[0].sourceChargeIds[0]] }; v.economics.otherCosts.push(row); invalid(v, "DUPLICATE_SOURCE_CHARGE_ALLOCATION"); });
  test("unresolved cost conversion and gas gaps", () => { const v = fixture(); v.economics.mandatoryCosts[0].boundStatus = "UNKNOWN"; v.economics.conversions.push({ conversionId: "conversion-1", sourceAsset: "TOKEN", sourceRawAmount: "1", settlementLower: q(1), nativeLower: q(1), usdLower: q(1), boundStatus: "UNKNOWN", evidenceRefs: ["local:conversion"] }); v.route.gasCoverage = "UNKNOWN"; const r = out(v); assert.equal(r.routePositive, "unknown"); for (const code of ["COST_BOUND_UNRESOLVED", "CONVERSION_BOUND_UNRESOLVED", "GAS_GAP_UNRESOLVED"]) assert(r.reasonCodes.includes(code)); });
  test("permutation canonical output", () => { const a = fixture(), b = fixture(); b.economics.mandatoryCosts.reverse(); for (const record of Object.values(b.evidence)) record.evidenceRefs = ["ref:b", "ref:a"]; for (const record of Object.values(a.evidence)) record.evidenceRefs = ["ref:a", "ref:b"]; assert.equal(E.canonicalJson(out(a)), E.canonicalJson(out(b))); });
  test("non-profit n/a evidence and invalid canonical route mapping", () => { const v = fixture(); v.claim.lane = "NON_PROFIT"; for (const record of Object.values(v.evidence)) record.directionalResult = "n/a"; let r = out(v); assert.equal(r.routePositive, "n/a"); assert.equal(r.routeDisposition, "N/A"); const profit = fixture(); profit.evidence.economics = evidence("PASS", "n/a"); invalid(profit, "EVIDENCE_DIRECTION_INVALID"); v.policyVersion = "legacy"; r = out(v); assert.equal(r.routePositive, "unknown"); assert.equal(r.routeDisposition, "UNKNOWN"); });
  test("automatic promotion always false", () => { for (const value of [fixture(), (() => { const v = fixture(); v.route.complete = "UNKNOWN"; return v; })(), (() => { const v = fixture(); v.policyVersion = "legacy"; return v; })()]) { const r = out(value); assert.equal(r.promotionStatus.automaticPromotion, false); assert.equal(r.validation.automaticPromotion, false); assert.equal(r.promotionStatus.owner, "orchestrator"); } });
  test("CLI exact size boundary accepted", () => { const json = JSON.stringify(fixture()); const padding = E.MAX_INPUT_BYTES - Buffer.byteLength(json); assert(padding >= 0); const run = cli(Buffer.from(`${json}${" ".repeat(padding)}`)); assert.equal(run.status, 0, run.stderr.toString()); assert.equal(JSON.parse(run.stdout.toString()).routePositive, "true"); });
  test("CLI overflow emits exactly one sanitized invalid result", () => { const json = JSON.stringify(fixture()); const padding = E.MAX_INPUT_BYTES + 1 - Buffer.byteLength(json); const run = cli(Buffer.from(`${json}${" ".repeat(padding)}`)); assert.notEqual(run.status, 0); assert.equal(run.stderr.toString(), ""); const text = run.stdout.toString(); assert.equal(text.trim().split(/\r?\n/).length, 1); const r = JSON.parse(text); assert.equal(r.inputStatus, "INVALID_INPUT"); assert.deepEqual(r.reasonCodes, ["INPUT_TOO_LARGE"]); });
  test("CLI rejects malformed UTF-8 once", () => { const run = cli(Buffer.from([0xc3, 0x28])); assert.notEqual(run.status, 0); assert.equal(run.stderr.toString(), ""); assert.equal(run.stdout.toString().trim().split(/\r?\n/).length, 1); assert.equal(JSON.parse(run.stdout.toString()).inputStatus, "INVALID_INPUT"); });
  test("CLI rejects extra args", () => { const run = cli(Buffer.from(JSON.stringify(fixture())), ["extra"]); assert.notEqual(run.status, 0); assert.equal(run.stderr.toString(), ""); const r = JSON.parse(run.stdout.toString()); assert.deepEqual(r.reasonCodes, ["CLI_ARGUMENTS_INVALID"]); assert.equal(r.routeDisposition, "UNKNOWN"); });
  test("syntax checks", () => { for (const file of ["evaluate-permissionless-profit-promotion-v1.js", "test-evaluate-permissionless-profit-promotion-v1.js"]) { const run = childProcess.spawnSync(process.execPath, ["--check", path.join(__dirname, file)], { encoding: "utf8" }); assert.equal(run.status, 0, run.stderr); } });
  process.stdout.write(`${JSON.stringify({ status: "PASS", tests, reviewCases: "1-10,12-18", networkRequests: 0, automaticPromotion: false, owner: "orchestrator" })}\n`);
}

try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
