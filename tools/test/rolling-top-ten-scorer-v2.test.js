"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const scorer = require("../atomic/ethereum-top-trades-7d-reconstruction/rolling-top-ten-scorer-v2");
const analyzer = require("../atomic/ethereum-top-trades-7d-reconstruction/rolling-ethereum-top-ten-analyzer");

function h(index) { return `0x${BigInt(index).toString(16).padStart(64, "0")}`; }
function base(index, overrides = {}) { return { transactionHash: h(index), leadTier: 1, selector4: "0x12345678", calldataBytes: 68, receiptStatus: "SUCCESS", ordinaryKind: "NONE", evidence: { transaction: true, receipt: true, decodedLogs: true, fullBlock: true }, roleTaggedCounts: { CALLER: 1, RECIPIENT: 1 }, accounting: {}, authorization: {}, replay: {}, precision: {}, transition: {}, ...overrides }; }
function pairs() {
  return [
    { className: "ACCOUNTING_CONSERVATION", signal: base(101, { accounting: { completeFlowSet: true, unmatchedFlowCount: 1 } }), control: base(1, { accounting: { completeFlowSet: true, unmatchedFlowCount: 0, transferCount: 4 } }) },
    { className: "AUTHORIZATION_OR_RECIPIENT", signal: base(102, { authorization: { roleBindingComplete: true, unexpectedRecipientCount: 1 } }), control: base(2, { authorization: { roleBindingComplete: true, unexpectedRecipientCount: 0, recipientCount: 3 } }) },
    { className: "REPLAY_OR_DUPLICATE", signal: base(103, { replay: { identityBindingComplete: true, repeatedIdentityCount: 1 } }), control: base(3, { replay: { identityBindingComplete: true, repeatedIdentityCount: 0, sameRoleRepeatCount: 1 } }) },
    { className: "PRICE_OR_PRECISION", signal: base(104, { precision: { precisionInputsComplete: true, mixedDecimalRemainderCount: 1 } }), control: base(4, { precision: { precisionInputsComplete: true, mixedDecimalRemainderCount: 0, precisionSensitiveEventCount: 1 } }) },
    { className: "PUBLIC_STATE_TRANSITION", signal: base(105, { transition: { transitionBindingComplete: true, oneShotTransitionCount: 1 } }), control: base(5, { transition: { transitionBindingComplete: true, oneShotTransitionCount: 0, durableTransitionCount: 1, stateEventCount: 1 } }) },
  ];
}

test("five documented synthetic signal/control pairs separate conservatively", () => {
  for (const row of pairs()) {
    const signal = scorer.scorePhaseA(row.signal), control = scorer.scorePhaseA(row.control); assert.ok(signal.classScores[row.className] > control.classScores[row.className], row.className); assert.equal(signal.featureSignals[row.className].strong, true); assert.equal(signal.disposition, "UNKNOWN"); assert.equal(control.disposition, "UNKNOWN");
    assert.equal(typeof scorer.FEATURE_POLICY[row.className].prerequisite, "string"); assert.equal(typeof scorer.FEATURE_POLICY[row.className].ordinaryControl, "string");
  }
});

test("five signals are top five while v1 has demonstrably less separation", () => {
  const rows = pairs().flatMap((row) => [row.control, row.signal]), signals = new Set(pairs().map((row) => row.signal.transactionHash)), ranked = scorer.rankPhaseA(rows), v1 = scorer.v1Baseline(rows);
  assert.equal(ranked.slice(0, 5).every((row) => signals.has(row.transactionHash)), true); assert.equal(v1.slice(0, 5).filter((row) => signals.has(row.transactionHash)).length, 0);
});

test("row permutation is byte-identical and deterministic hash is only the final tie", () => {
  const rows = pairs().flatMap((row) => [row.signal, row.control]), forward = scorer.rankPhaseA(rows), reverse = scorer.rankPhaseA([...rows].reverse()); assert.equal(scorer.text(forward), scorer.text(reverse));
  const tied = scorer.rankPhaseA([base(202), base(201)]); assert.deepEqual(tied.map((row) => row.transactionHash), [h(201), h(202)]);
});

test("removing a strong precursor lowers priority without creating WATCH or any claim", () => {
  const strong = pairs()[0].signal, weakened = base(106, { accounting: { completeFlowSet: true, unmatchedFlowCount: 0 } }), ranked = scorer.rankPhaseA([weakened, strong]), weakRow = ranked.find((row) => row.transactionHash === weakened.transactionHash);
  assert.equal(ranked[0].transactionHash, strong.transactionHash); assert.equal(weakRow.classScores.ACCOUNTING_CONSERVATION, 0); assert.equal(weakRow.disposition, "UNKNOWN"); const serialized = JSON.stringify(weakRow); for (const forbidden of ["WATCH", "routePositive", "executable", "profit", "protocolLoss", "fork"]) assert.equal(serialized.includes(forbidden), false);
});

test("router, swap, liquidation, and settlement controls stay below anomaly shape unless strong precursor exists", () => {
  const anomaly = pairs()[0].signal, controls = ["ROUTER", "SWAP", "LIQUIDATION", "SETTLEMENT"].map((ordinaryKind, index) => base(210 + index, { ordinaryKind, accounting: { transferCount: 4 } })), ranked = scorer.rankPhaseA([...controls, anomaly]); assert.equal(ranked[0].transactionHash, anomaly.transactionHash); assert.equal(ranked.slice(1).every((row) => row.ordinaryPenalty > 0), true);
  const ordinaryStrong = scorer.scorePhaseA(base(220, { ordinaryKind: "ROUTER", accounting: { completeFlowSet: true, unmatchedFlowCount: 1 } })); assert.ok(ordinaryStrong.maxClassScore >= 4); assert.equal(ordinaryStrong.featureSignals.ACCOUNTING_CONSERVATION.strong, true);
  const reverted = scorer.rankPhaseA([anomaly, base(221, { receiptStatus: "REVERTED", transition: { durableTransitionCount: 1 } })]); assert.equal(reverted.at(-1).hardRejectReason, "REVERTED_DURABLE_TRANSITION");
});

test("phase B is capped at ten hashes and twenty dual requests", () => {
  const phaseA = scorer.rankPhaseA(Array.from({ length: 12 }, (_, index) => base(300 + index))), plan = scorer.phaseBPlan(phaseA); assert.equal(plan.hashCount, 10); assert.equal(plan.hashes.length, 10); assert.equal(plan.requests.length, 20); assert.equal(plan.traceRequestCap, 20); assert.equal(new Set(plan.requests.map((row) => row.transactionHash)).size, 10);
});

test("unavailable, malformed, and disagreeing phase B aggregates remain UNKNOWN", () => {
  const phaseA = scorer.rankPhaseA([base(401), base(402), base(403)]), aggregate = { traceCallCount: 2, nativeMovementCount: 1, prestateAccountCount: 2, balanceDeltaCount: 1, storageChangeCount: 0, roleCallCount: 1, aggregateCommitment: "a".repeat(64) }, evidence = {
    [h(401)]: { status: "UNAVAILABLE" },
    [h(402)]: { status: "MALFORMED" },
    [h(403)]: { status: "AVAILABLE", left: aggregate, right: { ...aggregate, traceCallCount: 3 } },
  }, output = scorer.phaseBRerank(phaseA, evidence); assert.equal(output.rows.every((row) => row.disposition === "UNKNOWN" && row.phaseBStatus === "UNKNOWN"), true); assert.deepEqual(new Set(output.rows.map((row) => row.phaseBReason)), new Set(["UNAVAILABLE", "MALFORMED", "DISAGREEMENT"]));
});

test("scorer outputs are leak-free review priority only", () => {
  const output = scorer.rankPhaseA([base(501, { roleTaggedCounts: { CALLER: 2, ROUTER: 1 } })]); assert.equal(scorer.leakScan(output), true); const serialized = JSON.stringify(output); for (const forbidden of ["https://", "\"endpoint\":", "\"provider\":", "\"inventory\":", "\"rawTrace\":", "\"calldata\":", "0x1111111111111111111111111111111111111111", "routePositive", "WATCH"]) assert.equal(serialized.includes(forbidden), false);
});

function analyzerRow(index, projection) { return { transactionHash: h(index), classification: { type: "pattern-only", verified: false }, rankingEvidence: { confidence: 0, reproducibility: 0, liquidityCapacity: 0 }, ledger: { coverage: {}, reconciliationComplete: false }, economics: { status: "UNKNOWN", routePositive: false }, scorerV2Projection: projection }; }
function collection(rows) { return { window: { chainId: "1", immutable: true, start: { number: "100", hash: h(900) }, finalized: { number: "200", hash: h(901) } }, reconciled: { rows } }; }

test("rolling analyzer emits v2 priorities while preserving nonclaims and prior artifact validation", () => {
  const synthetic = pairs().flatMap((row) => [row.control, row.signal]), rows = synthetic.map((candidate, index) => analyzerRow(600 + index, { ...candidate, transactionHash: undefined })), state = analyzer.buildState(collection(rows));
  assert.equal(state.results.length, 10); assert.equal(state.results.every((row, index) => row.reviewPriority.version === "v2" && row.reviewPriority.rank === index + 1), true); assert.equal(state.nonclaims.routePositive, "unknown"); assert.equal(state.nonclaims.signing, false); assert.equal(state.nonclaims.broadcast, false); assert.equal(state.nonclaims.forkClaim, false); assert.equal(state.results.every((row) => row.disposition === "UNKNOWN" && row.routePositive === "unknown"), true);
  assert.equal(analyzer.validateDirectory(analyzer.LIVE_OUTPUT_DIRECTORY).results.length, 10);
});
