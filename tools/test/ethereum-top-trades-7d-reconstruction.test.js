"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildCandidateForensics,
  buildLedger,
  calculateEconomics,
  classifyCandidate,
  fullHash,
  sanitizeLog,
} = require("../atomic/ethereum-top-trades-7d-reconstruction/forensics");
const { fixtureBundle, leakScan } = require("../atomic/ethereum-top-trades-7d-reconstruction/output");

const BENEFICIARY = "0x1000000000000000000000000000000000000001";
const OTHER = "0x2000000000000000000000000000000000000002";
const COINBASE = "0x3000000000000000000000000000000000000003";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ZERO = "0x0000000000000000000000000000000000000000";
const FIXTURE = path.join(__dirname, "..", "atomic", "ethereum-top-trades-7d-reconstruction", "fixtures", "offline-v1.json");

function zeroHaircuts() {
  return Object.fromEntries(["slippage", "unwind", "financing", "latency", "competition", "uncertainty"].map((name) => [name, { usdMicros: "0", nativeWei: "0" }]));
}

function capital() {
  return { ownUsdMicros: "0", borrowedUsdMicros: "0", peakUsdMicros: "1000000", ownNativeWei: "0", borrowedNativeWei: "0", peakNativeWei: "500000000000000" };
}

function nativeMeta() {
  return { historicalDecimals: 18, decimalsSourceBlock: "20050400", settlementAsset: true, price: { exact: true, sourceBlock: "20050400", usdMicrosPerWhole: "2000000000", nativeWeiPerWhole: "1000000000000000000" } };
}

function receipt(gasUsed = "21000", effectiveGasPrice = "1") {
  return { gasUsed, effectiveGasPrice, blobGasUsed: "0", blobGasPrice: "0" };
}

function completeCoverage() {
  return { clusterComplete: true, tokenStateComplete: true, nativeFlowsComplete: true, nativeStateComplete: true, liabilitiesComplete: true, fundingSourcesComplete: true };
}

function reconciledTokenLedger(amount = "1000000") {
  return buildLedger({
    actor: BENEFICIARY,
    actorStatus: "BENEFICIARY_PROVEN",
    cluster: { addresses: [BENEFICIARY], controlEvidence: [{ kind: "fixture-control" }] },
    coverage: completeCoverage(),
    transfers: [{ token: USDC, from: OTHER, to: BENEFICIARY, amount }],
    stateDiffs: [{ asset: USDC, address: BENEFICIARY, before: "0", after: amount }, { asset: "native", address: BENEFICIARY, before: "21000", after: "0" }],
    receipt: receipt(),
    blockFeeRecipient: COINBASE,
  });
}

function economics(ledger, assets, extra = {}) {
  return calculateEconomics({
    ledger,
    candidateBlockNumber: "20050400",
    assets: { native: nativeMeta(), ...assets },
    receipt: receipt(),
    haircuts: zeroHaircuts(),
    capital: capital(),
    gates: { source: true, reachability: true, reproducibility: true, publicActor: true },
    ...extra,
  });
}

test("offline fixture keeps tx.to separate from provisional actor and fails strict KNOWN prerequisites closed", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const row = fixtureBundle(fixture)["reconciled.json"].rows[0];
  assert.notEqual(fixture.candidates[0].transaction.to, row.ledger.actor);
  assert.equal(row.ledger.actor, fixture.candidates[0].transaction.from);
  assert.equal(row.ledger.actorStatus, "PROVISIONAL_ACTOR");
  assert.equal(row.ledger.beneficiary, null);
  assert.equal(row.economics.status, "UNKNOWN");
  assert.equal(row.economics.routePositive, "unknown");
  assert.ok(row.blockers.includes("native-flow-state-reconciliation-incomplete"));
});

test("network-v1 rows are forced UNKNOWN even when fixture economics would otherwise be computable", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  fixture.candidates[0].economicsCoverage = "NOT_COLLECTED_V1";
  const row = fixtureBundle(fixture)["reconciled.json"].rows[0];
  assert.deepEqual(row.economics, { status: "UNKNOWN", economicsCoverage: "NOT_COLLECTED_V1", reason: "insufficient-collected-economic-evidence", routePositive: "unknown" });
});

test("every UNKNOWN economics result uses the explicit tri-state route value", () => {
  const unknown = calculateEconomics({ ledger: null });
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.routePositive, "unknown");
});

test("historical token decimals and exact prices replace universal 18 decimals and fixed USD multipliers", () => {
  const ledger = reconciledTokenLedger();
  const result = economics(ledger, {
    [USDC]: { historicalDecimals: 6, decimalsSourceBlock: "20050400", settlementAsset: true, price: { exact: true, sourceBlock: "20050400", usdMicrosPerWhole: "1000000", nativeWeiPerWhole: "500000000000000" } },
  });
  assert.equal(result.status, "KNOWN");
  assert.equal(result.valuedAssets[0].usdMicros, "1000000");
  assert.equal(result.net.usdMicros, "999999");
  assert.deepEqual(result.netBpsOfPeakCapital, { status: "EXACT_RATIONAL", numerator: "9999990000", denominator: "1000000", units: "bps" });
  const noPrice = economics(ledger, { [USDC]: { historicalDecimals: 6, decimalsSourceBlock: "20050400", settlementAsset: true } });
  assert.equal(noPrice.status, "UNKNOWN");
});

test("WETH unwrap and matching native forwarding reconcile on one ETH ledger without double count", () => {
  const ledger = buildLedger({
    beneficiary: BENEFICIARY,
    transfers: [
      { token: WETH, from: OTHER, to: BENEFICIARY, amount: "100" },
    ],
    stateDiffs: [{ asset: WETH, address: BENEFICIARY, before: "5", after: "5" }],
    nativeFlows: [
      { from: WETH, to: BENEFICIARY, amountWei: "100" },
      { from: BENEFICIARY, to: OTHER, amountWei: "100" },
    ],
    wethEvents: [{ kind: "withdrawal", account: BENEFICIARY, amount: "100" }],
    cluster: { addresses: [BENEFICIARY], controlEvidence: [{ kind: "fixture-control" }] },
    coverage: completeCoverage(),
    blockFeeRecipient: COINBASE,
  });
  assert.deepEqual(ledger.assetDeltas, [{ asset: WETH, rawDelta: "0" }, { asset: "native", rawDelta: "0" }]);
  assert.equal(ledger.transferVsStateDiff.find((row) => row.asset === WETH).transferDelta, "0");
  assert.equal(ledger.wethNativeReconciliation.unwrapAmountWei, "100");
  assert.equal(ledger.wethNativeReconciliation.complete, true);
});

test("empty WETH conversion evidence is explicitly incomplete", () => {
  const ledger = buildLedger({ beneficiary: BENEFICIARY, blockFeeRecipient: COINBASE });
  assert.equal(ledger.wethNativeReconciliation.evidencePresent, false);
  assert.equal(ledger.wethNativeReconciliation.complete, false);
});

test("canonical WETH Deposit and Withdrawal logs become typed conversion facts", () => {
  const base = { address: WETH, blockHash: `0x${"1".repeat(64)}`, blockNumber: "0x1", transactionHash: `0x${"2".repeat(64)}`, transactionIndex: "0x0", logIndex: "0x0", removed: false };
  const accountTopic = `0x${"0".repeat(24)}${BENEFICIARY.slice(2)}`;
  const amountData = `0x${100n.toString(16).padStart(64, "0")}`;
  const deposit = sanitizeLog({ ...base, topics: ["0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c", accountTopic], data: amountData });
  const withdrawal = sanitizeLog({ ...base, logIndex: "0x1", topics: ["0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65", accountTopic], data: amountData });
  assert.deepEqual(deposit.wethEvent, { kind: "deposit", account: BENEFICIARY, amount: "100" });
  assert.deepEqual(withdrawal.wethEvent, { kind: "withdrawal", account: BENEFICIARY, amount: "100" });
  assert.throws(() => sanitizeLog({ ...base, topics: deposit.topics, data: `0x${"00".repeat(1025)}` }), /event-data-cap-or-schema/);
});

test("flash principal is excluded from revenue and only net premium remains in flow delta", () => {
  const ledger = buildLedger({
    beneficiary: BENEFICIARY,
    transfers: [{ token: USDC, from: OTHER, to: BENEFICIARY, amount: "1000" }, { token: USDC, from: BENEFICIARY, to: OTHER, amount: "1010" }],
    flashLoans: [{ asset: USDC, principal: "1000", premium: "10" }],
    blockFeeRecipient: COINBASE,
  });
  assert.equal(ledger.assetDeltas[0].rawDelta, "-10");
  assert.equal(ledger.flashLoans[0].principalTreatment, "excluded-from-revenue");
  assert.equal(ledger.flashLoans[0].premiumTreatment, "included-in-net-asset-delta");
});

test("transfer logs are reconciled against state diffs and disagreement fails economics closed", () => {
  const ledger = buildLedger({
    beneficiary: BENEFICIARY,
    transfers: [{ token: USDC, from: OTHER, to: BENEFICIARY, amount: "100" }],
    stateDiffs: [{ asset: USDC, address: BENEFICIARY, before: "10", after: "100" }],
    blockFeeRecipient: COINBASE,
  });
  assert.equal(ledger.transferVsStateDiff[0].agrees, false);
  assert.equal(ledger.reconciliationComplete, false);
  assert.equal(economics(ledger, {}).reason, "insufficient-ledger-coverage-or-mismatch");
});

test("full transaction hashes are mandatory and truncated provenance is rejected", () => {
  assert.equal(fullHash(`0x${"a".repeat(64)}`), `0x${"a".repeat(64)}`);
  assert.throws(() => fullHash(`0x${"a".repeat(16)}`), /truncated/);
});

test("Compound absorb and Maker bark establish liquidation class but never automatic profit", () => {
  for (const event of ["AbsorbCollateral", "Bark"]) {
    const classification = classifyCandidate({ recognizedEvents: [{ class: "liquidation", protocol: event === "Bark" ? "maker-dog" : "compound-iii", event }] });
    assert.equal(classification.type, "liquidation");
    assert.equal(classification.profitEstablished, false);
  }
});

test("direct fee-recipient transfer is not called PBS without explicit evidence", () => {
  const direct = buildLedger({ beneficiary: BENEFICIARY, nativeFlows: [{ from: BENEFICIARY, to: COINBASE, amountWei: "7" }], blockFeeRecipient: COINBASE });
  assert.equal(direct.directFeePayments[0].kind, "direct-fee-recipient");
  const pbs = buildLedger({ beneficiary: BENEFICIARY, nativeFlows: [{ from: BENEFICIARY, to: COINBASE, amountWei: "7", pbsEvidence: true }], blockFeeRecipient: COINBASE });
  assert.equal(pbs.directFeePayments[0].kind, "pbs-explicit");
  const unrelated = buildLedger({ beneficiary: BENEFICIARY, nativeFlows: [{ from: BENEFICIARY, to: OTHER, amountWei: "7", pbsEvidence: true }], blockFeeRecipient: COINBASE });
  assert.equal(unrelated.directFeePayments.length, 0);
});

test("sandwich verification requires both common control and victim-output counterfactual", () => {
  const shape = { recognizedEvents: [], sharedPools: [USDC], order: { frontIndex: 1, victimIndex: 2, backIndex: 3 } };
  assert.equal(classifyCandidate(shape).type, "pattern-only");
  assert.equal(classifyCandidate({ ...shape, commonControl: { established: true } }).type, "pattern-only");
  const verified = classifyCandidate({ ...shape, commonControl: { established: true, evidence: ["same-sender"] }, victimOutputCounterfactual: { status: "DEMONSTRATED", victimOutputWithoutSandwich: "101", observed: "99" } });
  assert.equal(verified.type, "sandwich");
  assert.equal(verified.verified, true);
});

test("backrun verification requires causal no-trigger replay", () => {
  const shape = { recognizedEvents: [], sharedPools: [USDC], order: { triggerIndex: 4, candidateIndex: 5 } };
  assert.equal(classifyCandidate(shape).type, "pattern-only");
  const verified = classifyCandidate({ ...shape, noTriggerReplay: { status: "DEMONSTRATED", candidateNetWithoutTrigger: "0" } });
  assert.equal(verified.type, "backrun");
  assert.equal(verified.verified, true);
});

test("material residual inventory without exact unwind makes economics UNKNOWN", () => {
  const ledger = reconciledTokenLedger();
  const result = economics(ledger, {
    [USDC]: { historicalDecimals: 6, decimalsSourceBlock: "20050400", price: { exact: true, sourceBlock: "20050400", usdMicrosPerWhole: "1000000", nativeWeiPerWhole: "500000000000000" } },
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "material-residual-inventory-unwound");
});

test("promotion is strict net greater than zero and requires every public route gate", () => {
  const empty = { reconciliationComplete: true, nativeFlowVsStateDiff: { complete: true, gasAddedBackWei: "0" }, assetDeltas: [], inboundFundingObserved: false, fundingAndLiabilityCoverageComplete: true };
  const zero = calculateEconomics({ ledger: empty, candidateBlockNumber: "20050400", assets: { native: nativeMeta() }, receipt: receipt("0", "0"), haircuts: zeroHaircuts(), capital: capital(), gates: { source: true, reachability: true, reproducibility: true, publicActor: true } });
  assert.equal(zero.net.usdMicros, "0");
  assert.equal(zero.routePositive, false);

  const ledger = reconciledTokenLedger();
  const assets = { [USDC]: { historicalDecimals: 6, decimalsSourceBlock: "20050400", settlementAsset: true, price: { exact: true, sourceBlock: "20050400", usdMicrosPerWhole: "1000000", nativeWeiPerWhole: "500000000000000" } } };
  assert.equal(economics(ledger, assets).routePositive, true);
  const gated = economics(ledger, assets, { gates: { source: true, reachability: true, reproducibility: true, publicActor: false } });
  assert.equal(gated.status, "UNKNOWN");
  assert.equal(gated.routePositive, "unknown");
  assert.equal(gated.reason, "public-route-gates-incomplete");
});

test("KNOWN economics requires ledger gas reconciliation to match receipt gas exactly", () => {
  const ledger = { reconciliationComplete: true, nativeFlowVsStateDiff: { complete: true, gasAddedBackWei: "1" }, assetDeltas: [], inboundFundingObserved: false, fundingAndLiabilityCoverageComplete: true };
  const result = calculateEconomics({ ledger, candidateBlockNumber: "20050400", assets: { native: nativeMeta() }, receipt: receipt("0", "0"), haircuts: zeroHaircuts(), capital: capital(), gates: { source: true, reachability: true, reproducibility: true, publicActor: true } });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "native-reconciliation-gas-mismatch");
  assert.equal(result.routePositive, "unknown");
});

test("sanitized output rejects locations, calldata, raw traces, raw errors, and secret header markers", () => {
  assert.throws(() => leakScan({ value: "https://example.invalid" }), /leak-scan/);
  assert.throws(() => leakScan({ calldata: "0x" }), /forbidden-field/);
  assert.throws(() => leakScan({ rawTrace: {} }), /forbidden-field/);
  assert.throws(() => leakScan({ rawError: "failure" }), /forbidden-field/);
  assert.throws(() => leakScan({ value: "x-api-key" }), /leak-scan/);
  assert.doesNotThrow(() => leakScan({ providerOrdinal: "provider-01", capability: true }));
});

test("immutable collected sample remains a 14-row input without reclassification claims", () => {
  const sample = path.join(__dirname, "..", "..", "reports", "raw", "fast", "atomic-ethereum-top-trades-7d-reconstruction", "2026-08-25T18-58-46-001Z-f6be219e", "candidates.json");
  const rows = JSON.parse(fs.readFileSync(sample, "utf8")).rows;
  assert.equal(rows.length, 14);
});
