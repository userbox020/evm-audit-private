"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const prefilter = require("../atomic/ethereum-top-trades-7d-reconstruction/rolling-top-ten-prefilter-v3");
const scorer = require("../atomic/ethereum-top-trades-7d-reconstruction/rolling-top-ten-scorer-v2");

const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222", C = "0x3333333333333333333333333333333333333333", D = "0x4444444444444444444444444444444444444444", TOKEN = "0x5555555555555555555555555555555555555555";
function h(index) { return `0x${BigInt(index).toString(16).padStart(64, "0")}`; }
function row(index, type = "pattern-only") { return { transactionHash: h(index), classification: { type, verified: false }, protocolBinding: { complete: false }, ledger: { reconciliationComplete: true } }; }
function transfer(from, to, amount = "5") { return { address: TOKEN, topics: [], recognized: null, eventFacts: null, transfer: { token: TOKEN, from, to, amount, logIndex: "0" } }; }
function event(className, protocol, eventName, facts, emitter = C) { return { address: emitter, topics: [h(700)], recognized: { class: className, protocol, event: eventName }, eventFacts: facts, transfer: null }; }
function candidate(logs = [], overrides = {}) { return { transaction: { from: A, to: B, selector4: "0x12345678", calldataBytes: 68, calldataCommitment: h(800) }, receipt: { status: "1", logs }, fullBlockProjection: { complete: true, rows: [{ selector4: "0x12345678", targetCommitment: h(801), callCommitment: h(802), targetsCurrentTarget: true }] }, ...overrides }; }
function pairs() {
  const duplicate = transfer(A, B, "5");
  return [
    { className: "ACCOUNTING_CONSERVATION", signal: [row(101), candidate([duplicate, { ...duplicate }])], control: [row(1), candidate([transfer(A, B, "5"), transfer(A, B, "6")])] },
    { className: "AUTHORIZATION_OR_RECIPIENT", signal: [row(102), candidate([event("protocol", "fixture", "Paid", { recipient: D, amount: "1" })])], control: [row(2), candidate([event("protocol", "fixture", "Paid", { recipient: B, amount: "1" })])] },
    { className: "REPLAY_OR_DUPLICATE", signal: [row(103), candidate([event("protocol", "fixture", "Claimed", { recipient: B, amount: "1" }), event("protocol", "fixture", "Claimed", { recipient: B, amount: "1" })])], control: [row(3), candidate([event("protocol", "fixture", "Claimed", { recipient: B, amount: "1" }), event("protocol", "fixture", "Claimed", { recipient: B, amount: "2" })])] },
    { className: "PRICE_OR_PRECISION", signal: [row(104), candidate([event("dex", "uniswap-v3", "Swap", { amount0: (1n << 130n).toString(), amount1: "-1", tick: "0" })])], control: [row(4), candidate([event("dex", "uniswap-v3", "Swap", { amount0: "100", amount1: "-99", tick: "0" })])] },
    { className: "PUBLIC_STATE_TRANSITION", signal: [row(105), candidate([event("state", "fixture", "Initialized", { recipient: B })])], control: [row(5), candidate([event("state", "fixture", "Paused", { recipient: B })])] },
  ];
}
function projected(pairRow) { return prefilter.projectCandidate(pairRow[0], pairRow[1]); }

test("five actual safe-projection-shaped signal/control pairs separate 5/5", () => {
  for (const pair of pairs()) { const signal = scorer.scorePhaseA(projected(pair.signal)), control = scorer.scorePhaseA(projected(pair.control)); assert.ok(signal.classScores[pair.className] > control.classScores[pair.className], pair.className); assert.equal(signal.disposition, "UNKNOWN"); assert.equal(signal.featureSignals[pair.className].strong, true); }
});

test("five prefilter signals are accepted as the top five", () => {
  const candidates = pairs().flatMap((pair) => [projected(pair.control), projected(pair.signal)]), signalHashes = new Set(pairs().map((pair) => pair.signal[0].transactionHash)), ranked = scorer.rankPhaseA(candidates); assert.equal(ranked.slice(0, 5).every((entry) => signalHashes.has(entry.transactionHash)), true);
});

test("projection and scorer ranking are byte-identical under row permutation", () => {
  const candidates = pairs().flatMap((pair) => [projected(pair.signal), projected(pair.control)]), forward = scorer.rankPhaseA(candidates), reverse = scorer.rankPhaseA([...candidates].reverse()); assert.equal(scorer.text(forward), scorer.text(reverse));
});

test("malformed or missing safe fields degrade or reject without strong evidence", () => {
  const malformedTransfer = { address: TOKEN, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], transfer: null }, malformed = prefilter.projectCandidate(row(201), candidate([malformedTransfer], { transaction: { from: A, to: B, selector4: "bad", calldataBytes: -1, calldataCommitment: "bad" } })), score = scorer.scorePhaseA(malformed); assert.equal(malformed.selector4, "0x00000000"); assert.equal(malformed.calldataBytes, 0); assert.equal(malformed.evidence.decodedLogs, false); assert.equal(score.maxClassScore < 4, true); assert.equal(score.disposition, "UNKNOWN");
  const missing = prefilter.projectCandidate(row(202), null); assert.equal(missing.receiptStatus, "UNKNOWN"); assert.equal(missing.evidence.receipt, false); assert.throws(() => prefilter.projectCandidate({ transactionHash: "bad" }, null), /PREFILTER_V3_HASH/);
});

test("router, swap, liquidation, and settlement controls retain conservative penalties", () => {
  const router = prefilter.projectCandidate(row(301), candidate([], { safeCallKind: "MULTICALL" })), swap = prefilter.projectCandidate(row(302), candidate([event("dex", "uniswap-v3", "Swap", { amount0: "1", amount1: "-1" })])), liquidation = prefilter.projectCandidate(row(303, "liquidation"), candidate([])), settlement = prefilter.projectCandidate(row(304), candidate([event("transition", "fixture", "Settled", { recipient: B })]));
  assert.deepEqual([router.ordinaryKind, swap.ordinaryKind, liquidation.ordinaryKind, settlement.ordinaryKind], ["ROUTER", "SWAP", "LIQUIDATION", "SETTLEMENT"]); assert.equal([router, swap, liquidation, settlement].every((entry) => scorer.scorePhaseA(entry).ordinaryPenalty > 0), true);
});

test("reverted durable transition is hard rejected and remains UNKNOWN", () => {
  const projection = prefilter.projectCandidate(row(401), candidate([event("state", "fixture", "Initialized", { recipient: B })], { receipt: { status: "0", logs: [event("state", "fixture", "Initialized", { recipient: B })] } })), score = scorer.scorePhaseA(projection); assert.equal(projection.transition.durableTransitionCount, 1); assert.equal(score.hardRejected, true); assert.equal(score.hardRejectReason, "REVERTED_DURABLE_TRANSITION"); assert.equal(score.disposition, "UNKNOWN");
});

test("selector and full-block frequencies are bounded and malformed over-cap sets degrade", () => {
  const rows = Array.from({ length: prefilter.CAP.fullBlockRows }, (_, index) => ({ selector4: index % 2 ? "0x12345678" : "0x87654321", targetCommitment: h(900 + index), callCommitment: h(1000 + (index % 3)), targetsCurrentTarget: index < 7 })), within = prefilter.projectCandidate(row(501), candidate([], { fullBlockProjection: { complete: true, rows } })); assert.equal(within.fullBlock.complete, true); assert.equal(within.fullBlock.rowCount, 64); assert.equal(within.fullBlock.targetFrequency, 7); assert.equal(within.fullBlock.selectorFrequency, 32); assert.ok(within.fullBlock.duplicateSelectorCommitmentCount <= 64);
  const over = prefilter.projectCandidate(row(502), candidate([], { fullBlockProjection: { complete: true, rows: [...rows, rows[0]] } })); assert.equal(over.fullBlock.complete, false); assert.equal(over.fullBlock.rowCount, 0);
});

test("role commitments expose only capped tags/counts and hide every raw address", () => {
  const projection = prefilter.projectCandidate(row(601), candidate([transfer(A, D), event("protocol", "fixture", "Paid", { recipient: D })])); assert.deepEqual(Object.keys(projection.roleTaggedCounts).sort(), [...prefilter.ROLES].sort()); assert.match(projection.roleAggregateCommitment, /^[0-9a-f]{64}$/); const serialized = JSON.stringify(projection); for (const address of [A, B, C, D, TOKEN]) assert.equal(serialized.includes(address), false); assert.equal(prefilter.leakScan(projection), true);
});

test("cycle01/02/03 sanitized artifacts project without mutation and retain nonclaims", () => {
  const parent = path.resolve(__dirname, "../../reports/raw/fast/atomic-ethereum-top-trades-7d-reconstruction");
  for (const cycle of ["rolling-ethereum-top-ten-20260828-01", "rolling-ethereum-top-ten-20260828-02", "rolling-ethereum-top-ten-20260828-03"]) { const statePath = path.join(parent, cycle, "state.json"), manifestPath = path.join(parent, cycle, "manifest.json"), stateBefore = fs.readFileSync(statePath), manifestBefore = fs.readFileSync(manifestPath), state = JSON.parse(stateBefore); const projections = state.results.map((entry) => prefilter.projectCandidate(entry, null)); assert.equal(projections.length, 10); assert.equal(projections.every((entry) => entry.disposition === "UNKNOWN"), true); assert.equal(state.nonclaims.routePositive, "unknown"); assert.equal(state.nonclaims.signing, false); assert.equal(state.nonclaims.broadcast, false); assert.deepEqual(fs.readFileSync(statePath), stateBefore); assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore); }
});
