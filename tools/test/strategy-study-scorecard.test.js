"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface } = require("ethers");
const { buildRegistry, decodeStudyLog } = require("../strategy-study/registry");
const { buildScorecard, renderMarkdown } = require("../strategy-study/scorecard");

const T = BigInt(Date.parse("2026-10-20T00:00:00Z") / 1000);
const DAY = 86400n;
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const D = "0x4444444444444444444444444444444444444444";
const hash = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const registries = Object.fromEntries([1, 8453].map(chainId => [chainId, buildRegistry({ chainId, readFile() {
  const error = new Error("no files in pure fixture"); error.code = "ENOENT"; throw error;
} })]));
const SAMPLES = {
  "aave-v3": ["LiquidationCall", [A, B, C, 10, 20, D, false]],
  "aave-v4": ["LiquidationCall", [1, 1, C, D, true, 10, 11, [-1, -2, 3], 20, 21, 19]],
  "morpho-blue": ["Liquidate", [hash(99), D, C, 10, 11, 20, 0, 0]],
  "compound-iii": ["AbsorbDebt", [D, C, 10, 20]],
  "euler-evk": ["Liquidate", [D, C, B, 10, 20]],
  "euler-evk-factory": ["ProxyCreated", [A, true, B, "0x1234"]],
  "silo-v3": ["LiquidationCall", [D, B, C, 10, 20, true]],
  "silo-v3-defaulting-accounting": ["DefaultingLiquidation", [10, 8]],
};
function event({ chainId = 1, sourceId = "aave-v3", tx = 1, block = tx, logIndex = 0, timestamp = T - 60n, eventName, values } = {}) {
  const original = registries[chainId].sources.find(row => row.id === sourceId);
  const src = { ...original, addresses: original.addresses.length ? original.addresses : [A] };
  const [defaultName, defaultValues] = SAMPLES[sourceId];
  const encoded = new Interface(src.abi).encodeEventLog(eventName || defaultName, values || defaultValues);
  const decoded = decodeStudyLog(src, { chainId, address: src.addresses[0], ...encoded });
  assert.equal(decoded.status, "decoded");
  return { chainId, sourceId, blockNumber: String(block), blockHash: hash(1000000 + block), txHash: hash(tx), logIndex: String(logIndex),
    timestamp: timestamp === null ? null : String(timestamp), decoded, rpcStrength: "corroborated" };
}
function receipt(e, overrides = {}) {
  return { chainId: e.chainId, txHash: e.txHash, blockHash: e.blockHash, transactionIndex: "0", status: "1", gasUsed: "21000",
    effectiveGasPrice: "1000000000", feeCompleteness: "unknown", traceComplete: false, stateComplete: false, costComplete: false,
    rpcStrength: "corroborated", ...overrides };
}
function score(events = [], receipts = [], options = {}) { return buildScorecard({ windowDays: 7, events, receipts, ...options }); }
function range(fromBlock, toBlock, status = "validated", overrides = {}) {
  return { chainId: 1, sourceId: "aave-v3", fromBlock: String(fromBlock), toBlock: String(toBlock), status, rpcStrength: "corroborated", ...overrides };
}

test("empty census has unknown economics and costs, not zero profit or whole-chain completeness", () => {
  const s = score();
  assert.equal(s.summary.uniqueObservedEvents, 0);
  assert.equal(s.fees.knownFeeWeiSum, null);
  assert.equal(s.fees.gasUsed.min, null);
  assert.equal(s.quality.trace.fraction.value, null);
  assert.equal(s.protocolWideComplete, false);
  assert.equal(s.coverage.percentageComplete, null);
  assert.equal(s.statistics.descriptiveOnly, true);
  for (const key of ["realizedProfitUSD", "realizedProfitNative", "captureProbability", "winRate", "expectedNetPerDay"]) {
    assert.equal(s.economics[key], null);
    assert.ok(s.economics.reasons[key]);
  }
  assert.match(renderMarkdown(s), /No demonstrated winner/);
});

test("canonical duplicate event and receipt rows collapse; conflicting facts fail", () => {
  const e = event(), r = receipt(e, { feeCompleteness: "complete", totalFeeWei: "123" });
  const alias = { ...e, blockNumber: 1, logIndex: 0, blockHash: `0x${e.blockHash.slice(2).toUpperCase()}` };
  const s = score([e, alias], [r, { ...r }]);
  assert.equal(s.summary.inputEventRows, 2);
  assert.equal(s.summary.uniqueObservedEvents, 1);
  assert.equal(s.summary.duplicateEventRows, 1);
  assert.equal(s.summary.duplicateReceiptRows, 1);
  assert.equal(s.fees.knownFeeWeiSum, "123");
  assert.throws(() => score([e, { ...e, timestamp: String(T - 59n) }]), /CONFLICTING_EVENT/);
  assert.throws(() => score([e, { ...e, decoded: { ...e.decoded, fields: { ...e.decoded.fields, debtToCover: "11" } } }]), /CONFLICTING_EVENT/);
  assert.throws(() => score([e], [r, { ...r, totalFeeWei: "124" }]), /CONFLICTING_RECEIPT/);
});

test("several events and protocols in one transaction charge gas once globally", () => {
  const a = event(), m = event({ sourceId: "morpho-blue", logIndex: 1 });
  const s = score([a, m, event({ logIndex: 2 })], [receipt(a, { feeCompleteness: "complete", totalFeeWei: "777" })]);
  assert.equal(s.summary.inWindowEvents, 3);
  assert.equal(s.summary.primaryEventCount, 3);
  assert.equal(s.summary.primaryLiquidationTransactionCount, 1);
  assert.equal(s.summary.uniqueCensusTransactions, 1);
  assert.equal(s.groups.length, 2);
  assert.equal(s.groups.reduce((sum, g) => sum + g.uniqueTransactions, 0), 2);
  assert.equal(s.fees.knownFeeWeiSum, "777");
  assert.equal(s.fees.gasUsed.sampleCount, 1);
  assert.equal(s.summary.independentTradeCount, null);
});

test("same tx hash on two chains represents two transactions and fees, not one", () => {
  const eth = event(), base = event({ chainId: 8453 });
  const s = score([eth, base], [receipt(eth, { feeCompleteness: "complete", totalFeeWei: "10" }), receipt(base, { feeCompleteness: "complete", totalFeeWei: "20" })]);
  assert.equal(s.summary.uniqueCensusTransactions, 2);
  assert.equal(s.fees.knownFeeWeiSum, "30");
  assert.deepEqual(s.fees.chains.map(row => row.knownFeeWeiSum), ["10", "20"]);
});

test("Silo companion accounting and data are not standalone liquidations", () => {
  const primary = event({ sourceId: "silo-v3" });
  const companion = event({ sourceId: "silo-v3", logIndex: 1, eventName: "DefaultingLiquidationData", values: [B, C, 15, 5, 10] });
  const accounting = event({ sourceId: "silo-v3-defaulting-accounting", logIndex: 2 });
  const s = score([primary, companion, accounting]);
  assert.equal(s.summary.primaryEventCount, 1);
  assert.equal(s.summary.primaryLiquidationTransactionCount, 1);
  assert.equal(s.summary.borrowerPrimaryEventCount, 1);
  assert.equal(s.summary.actionCounts["defaulting-companion"], 1);
  assert.equal(s.summary.actionCounts["defaulting-accounting-companion"], 1);
  assert.equal(s.groups[0].observedEvents, 3);
  assert.equal(s.groups[0].primaryEventCount, 1);
  assert.equal(score([companion, accounting]).summary.primaryLiquidationTransactionCount, 0);
});

test("Compound absorption debt/collateral and purchase classes stay separate, without reward assumptions", () => {
  const debt = event({ sourceId: "compound-iii" });
  const collateral = event({ sourceId: "compound-iii", logIndex: 1, eventName: "AbsorbCollateral", values: [D, C, B, 100, 200] });
  const buy = event({ sourceId: "compound-iii", tx: 2, eventName: "BuyCollateral", values: [D, B, 100, 200] });
  const s = score([debt, collateral, buy]);
  assert.equal(s.summary.primaryEventCount, 0);
  assert.equal(s.summary.actionCounts["absorb-debt"], 1);
  assert.equal(s.summary.actionCounts["absorb-collateral"], 1);
  assert.equal(s.summary.actionCounts["buy-collateral"], 1);
  assert.equal(s.actorConcentration.length, 3);
  assert.deepEqual(s.actorConcentration.find(r => r.actionClass === "buy-collateral").actors[0].roles, ["buyer-not-proven-recipient"]);
  assert.ok(s.limitations.some(note => note.includes("not immediate absorber reward")));
});

test("factory creation is discovery; all protocol raw decodes validate without inferring profit", () => {
  const events = Object.keys(SAMPLES).map((sourceId, i) => event({ sourceId, tx: i + 1 }));
  const s = score(events);
  assert.equal(s.summary.unresolvedInWindowEvents, 0);
  assert.equal(s.summary.actionCounts["deployment-discovery"], 1);
  assert.equal(s.summary.primaryEventCount, 5);
});

test("same-asset is only an actual asset relation, never a no-swap claim", () => {
  const same = event({ values: [A, A, C, 10, 20, D, false] });
  const unknownIds = event({ sourceId: "aave-v4", tx: 2 });
  const s = score([same, unknownIds]);
  assert.equal(s.groups.find(g => g.protocol === "aave-v3").assetRelationship["same-asset"], 1);
  assert.equal(s.groups.find(g => g.protocol === "aave-v4").assetRelationship.unknown, 1);
  assert.ok(s.groups.every(g => g.actualSwapRoute === "UNKNOWN"));
  const invented = { ...unknownIds, decoded: { ...unknownIds.decoded, assetRelationship: "same-asset" } };
  assert.equal(score([invented]).gaps.unresolvedEvents[0].reason, "UNSUPPORTED_ASSET_RELATIONSHIP");
});

test("UTC windows are half open; missing timestamps are gaps, not implicit zero-time events", () => {
  const rows = [event({ tx: 1, timestamp: T - 7n * DAY }), event({ tx: 2, timestamp: T - 1n }),
    event({ tx: 3, timestamp: T }), event({ tx: 4, timestamp: T - 7n * DAY - 1n }), event({ tx: 5, timestamp: null })];
  const s = score(rows);
  assert.equal(s.summary.inWindowEvents, 2);
  assert.equal(s.summary.outOfWindowEvents, 2);
  assert.equal(s.summary.missingTimestampEvents, 1);
  assert.equal(s.gaps.missingTimestampEventKeys.length, 1);
  assert.equal(s.daily.length, 7);
  assert.equal(s.daily[0].dateUtc, "2026-10-13");
  assert.equal(s.daily[0].observedEvents, 1);
  assert.equal(s.daily[6].dateUtc, "2026-10-19");
  assert.equal(s.daily[6].observedEvents, 1);
  assert.equal(s.statistics.observedUtcDayClusters, 2);
});

test("nested 7/30/90-day reuse matches disjoint older slices without independent-window inference", () => {
  const events = [event({ tx: 1, timestamp: T - DAY }), event({ tx: 2, timestamp: T - 10n * DAY }),
    event({ tx: 3, timestamp: T - 40n * DAY }), event({ tx: 4, timestamp: T - 91n * DAY })];
  const receipts = events.map((e, i) => receipt(e, { feeCompleteness: "complete", totalFeeWei: String((i + 1) * 100) }));
  const seven = score(events, receipts), thirty = score(events, receipts, { windowDays: 30 }), ninety = score(events, receipts, { windowDays: 90 });
  assert.deepEqual([seven.summary.inWindowEvents, thirty.summary.inWindowEvents, ninety.summary.inWindowEvents], [1, 2, 3]);
  assert.deepEqual([seven.fees.knownFeeWeiSum, thirty.fees.knownFeeWeiSum, ninety.fees.knownFeeWeiSum], ["100", "300", "600"]);
  assert.equal(BigInt(thirty.fees.knownFeeWeiSum) - BigInt(seven.fees.knownFeeWeiSum), 200n);
  assert.equal(BigInt(ninety.fees.knownFeeWeiSum) - BigInt(thirty.fees.knownFeeWeiSum), 300n);
  for (const s of [seven, thirty, ninety]) {
    assert.equal(s.statistics.nestedWindowsIndependent, false);
    assert.equal(s.statistics.confidenceIntervals, null);
    assert.equal(s.statistics.inferentialRankingAllowed, false);
  }
  assert.equal(seven.statistics.clusterAnalysisRequired, false);
  assert.equal(thirty.statistics.clusterAnalysisRequired, true);
});

test("out-of-window, untimed and receipt-only transactions never add fees or failed-attempt denominators", () => {
  const inside = event(), outside = event({ tx: 2, timestamp: T }), untimed = event({ tx: 3, timestamp: null }), receiptOnly = event({ tx: 4 });
  const receipts = [inside, outside, untimed].map(e => receipt(e, { feeCompleteness: "complete", totalFeeWei: "100" }));
  receipts.push(receipt(receiptOnly, { status: "0", feeCompleteness: "complete", totalFeeWei: "9999" }));
  const s = score([inside, outside, untimed], receipts);
  assert.equal(s.fees.knownFeeWeiSum, "100");
  assert.equal(s.fees.receiptCount, 1);
  assert.equal(s.summary.excludedReceiptRows, 3);
  assert.equal(s.economics.winRate, null);
});

test("large wei and gas integers keep precision and nearest-rank quantiles use no interpolation", () => {
  const big = 900719925474099300000n;
  const events = [1, 2, 3, 4].map(tx => event({ tx }));
  const receipts = events.map((e, i) => receipt(e, { feeCompleteness: "complete", totalFeeWei: (big + BigInt(i)).toString(),
    gasUsed: (big + BigInt(3 - i)).toString(), effectiveGasPrice: (big * 2n + BigInt(i)).toString() }));
  const s = score(events, receipts);
  assert.equal(s.fees.knownFeeWeiSum, (4n * big + 6n).toString());
  assert.equal(s.fees.gasUsed.min, big.toString());
  assert.equal(s.fees.gasUsed.median, (big + 1n).toString());
  assert.equal(s.fees.gasUsed.p90, (big + 3n).toString());
  assert.equal(s.fees.gasUsed.p95, (big + 3n).toString());
  assert.equal(s.fees.gasUsed.max, (big + 3n).toString());
  assert.equal(s.fees.effectiveGasPriceWei.median, (big * 2n + 1n).toString());
  assert.doesNotThrow(() => JSON.stringify(s));
});

test("complete fee requires totalFeeWei; unknown fee totals are not promoted or calculated", () => {
  const e = event();
  assert.throws(() => score([e], [receipt(e, { feeCompleteness: "complete" })]), /COMPLETE_FEE_REQUIRES_TOTAL_FEE_WEI/);
  const s = score([e], [receipt(e, { totalFeeWei: "123" })]);
  assert.equal(s.fees.knownFeeWeiSum, null);
  assert.equal(s.fees.feeUnknownCount, 1);
  assert.equal(s.fees.gasUsed.sampleCount, 1);
  const knownZero = score([e], [receipt(e, { feeCompleteness: "complete", totalFeeWei: "0" })]);
  assert.equal(knownZero.fees.knownFeeWeiSum, "0");
});

test("missing receipts and false completeness flags use the entire census denominator; costs never enable profit", () => {
  const a = event(), b = event({ tx: 2 }), c = event({ tx: 3 });
  const s = score([a, b, c], [receipt(a, { traceComplete: true, stateComplete: true, costComplete: true }), receipt(b)]);
  for (const flag of ["trace", "state", "cost"]) {
    assert.equal(s.quality[flag].completeCount, 1);
    assert.equal(s.quality[flag].unknownCount, 2);
    assert.equal(s.quality[flag].receiptNotCompleteCount, 1);
    assert.equal(s.quality[flag].missingReceiptCount, 1);
    assert.equal(s.quality[flag].fraction.value, "1/3");
  }
  assert.equal(s.fees.feeUnknownCount, 3);
  assert.equal(s.fees.missingReceiptCount, 1);
  assert.equal(s.economics.realizedProfitNative, null);
  assert.equal(s.economics.realizedProfitUSD, null);
  assert.equal(s.economics.expectedNetPerDay, null);
});

test("actor concentration deduplicates actor per tx/class, uses participation denominator, and does not cluster", () => {
  const rows = [event(), event({ logIndex: 1 }), event({ logIndex: 2, values: [A, B, C, 10, 20, A, false] }),
    event({ tx: 2 }), event({ tx: 3, values: [A, B, C, 10, 20, B, false] })];
  const result = score(rows).actorConcentration[0];
  assert.equal(result.actorTransactionParticipations, 4);
  assert.deepEqual(result.actors.map(a => [a.actor, a.transactionParticipations]), [[D, 2], [A, 1], [B, 1]]);
  assert.equal(result.topK.top1.value, "2/4");
  assert.equal(result.topK.top3.value, "4/4");
  assert.equal(result.topK.top5.value, "4/4");
  assert.deepEqual(result.hhi, { numerator: "6", denominator: "16" });
  assert.match(result.denominator, /actor-transaction participations/);
  assert.match(result.interpretation, /not win\/capture probability/);
});

test("unknown and malformed decodes stay unresolved, including raw numeric/address violations", () => {
  const base = event();
  const malformed = [null, { status: "unresolved", reason: "ABI_DECODE_FAILED" }, { ...base.decoded, eventName: "Unknown" },
    { ...base.decoded, fields: { ...base.decoded.fields, debtToCover: 10 } },
    { ...base.decoded, fields: { ...base.decoded.fields, debtAsset: "not-an-address" } },
    { ...base.decoded, actor: "not-an-address" }, { ...base.decoded, actorRole: "beneficiary" },
    { ...base.decoded, actionType: "deployment-discovery" }];
  const rows = malformed.map((decoded, i) => ({ ...event({ tx: i + 1 }), decoded }));
  const s = score(rows);
  assert.equal(s.summary.uniqueObservedEvents, malformed.length);
  assert.equal(s.summary.unresolvedInWindowEvents, malformed.length);
  assert.equal(s.summary.primaryEventCount, 0);
  assert.equal(s.gaps.unresolvedEvents.length, malformed.length);
  assert.equal(s.quality.receipt.unknownCount, malformed.length);
  assert.equal(s.coverage.undeclaredEventSources.length, 1);
  assert.equal(s.actorConcentration[0].hhi, null);
  const unknown = score([{ ...base, sourceId: "constructor" }]);
  assert.equal(unknown.groups[0].protocol, "unknown");
});

test("every material row requires explicit corroboration, including receipts and coverage", () => {
  const e = event();
  for (const rpcStrength of [undefined, "single-provider", "unknown", "dual"]) {
    assert.throws(() => score([{ ...e, rpcStrength }]), /RPC_CORROBORATION_REQUIRED/);
    assert.throws(() => score([e], [receipt(e, { rpcStrength })]), /RPC_CORROBORATION_REQUIRED/);
    assert.throws(() => score([], [], { coverage: [range(1, 10, "validated", { rpcStrength })] }), /RPC_CORROBORATION_REQUIRED/);
  }
});

test("chain/hash/integer and receipt proof schemas fail closed without numeric monetary coercion", () => {
  const e = event();
  for (const patch of [{ chainId: "1" }, { chainId: 10 }, { txHash: "0xabc" }, { blockHash: "bad" }, { blockNumber: -1 },
    { logIndex: "0x1" }, { timestamp: 1792450000 }, { timestamp: "01" }, { blockNumber: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => score([{ ...e, ...patch }]), /INVALID_/);
  }
  for (const patch of [{ gasUsed: 21000 }, { effectiveGasPrice: "1.0" }, { totalFeeWei: "-1" }, { feeCompleteness: "partial" },
    { traceComplete: undefined }, { stateComplete: "true" }, { costComplete: 1 }, { status: 2 }, { chainId: 10 }]) {
    assert.throws(() => score([e], [receipt(e, patch)]), /INVALID_/);
  }
  assert.throws(() => score([e], [receipt(e, { status: 0 })]), /EVENT_ON_FAILED_RECEIPT/);
  assert.throws(() => score([e], [receipt(e, { blockHash: hash(123) })]), /RECEIPT_BLOCK_MISMATCH/);
  assert.throws(() => score([e, { ...event({ logIndex: 1 }), blockHash: hash(123) }]), /TRANSACTION_EVENT_CONFLICT/);
  assert.throws(() => score([e, event({ tx: 2, block: 1, timestamp: T - 59n })]), /BLOCK_EVENT_CONFLICT/);
});

test("coverage unions overlapping/adjacent ranges without invented denominator or market-block weighting", () => {
  const coverage = [range(10, 20), range(15, 25), range(26, 30), range(28, 35, "missing"), range(34, 40, "missing"),
    range(10, 20, "validated", { addressCount: 2 })];
  const s = score([], [], { coverage });
  const c = s.coverage.ranges[0];
  assert.deepEqual(c.validatedIntervals, [{ fromBlock: "10", toBlock: "30" }]);
  assert.deepEqual(c.missingIntervals, [{ fromBlock: "28", toBlock: "40" }]);
  assert.deepEqual(c.statusOverlapIntervals, [{ fromBlock: "28", toBlock: "30" }]);
  assert.equal(c.validatedBlockCount, "21");
  assert.equal(c.missingBlockCount, "13");
  assert.equal(c.declaredUnionBlockCount, "31");
  assert.deepEqual(c.declaredAddressCounts, [2]);
  assert.equal(c.unknownAddressCount, true);
  assert.equal(c.protocolWideComplete, false);
  assert.equal(c.percentageComplete, null);
  assert.throws(() => score([], [], { coverage: [range(2, 1)] }), /INVALID_COVERAGE_RANGE/);
  assert.throws(() => score([], [], { coverage: [range(1, 2, "validated", { addressCount: -1 })] }), /INVALID_ADDRESS_COUNT/);
});

test("coverage is separated by chain/source and preserves large block precision", () => {
  const big = 9007199254740993n;
  const s = score([], [], { coverage: [range(big, big + 2n), range(big + 1n, big + 4n),
    range(1, 2, "validated", { chainId: 8453 }), range(1, 2, "missing", { sourceId: "euler-evk" })] });
  assert.equal(s.coverage.ranges.length, 3);
  const c = s.coverage.ranges.find(row => row.chainId === 1 && row.sourceId === "aave-v3");
  assert.equal(c.declaredUnionBlockCount, "5");
  assert.equal(c.validatedIntervals[0].toBlock, (big + 4n).toString());
});

test("output is deterministic under input reordering and renderer exposes gaps without winner claims", () => {
  const events = [event(), event({ chainId: 8453, tx: 2 }), { ...event({ tx: 3 }), decoded: null }];
  const receipts = events.slice(0, 2).map(e => receipt(e, { feeCompleteness: "complete", totalFeeWei: "5" }));
  const coverage = [range(1, 2), range(3, 4, "missing")];
  const first = score(events, receipts, { coverage, limitations: ["Caller-specific gap | detail", "Another gap"] });
  const second = score([...events].reverse(), [...receipts].reverse(), { coverage: [...coverage].reverse(), limitations: ["Another gap", "Caller-specific gap | detail"] });
  assert.deepEqual(first, second);
  const markdown = renderMarkdown(first);
  for (const text of ["No demonstrated winner", "not independent trades", "UNKNOWN", "Unknown fees are not zero", "Protocol-wide complete: false", "unresolved", "nearest rank", "Caller-specific gap \\| detail"]) assert.ok(markdown.includes(text), text);
  assert.throws(() => renderMarkdown({}), /INVALID_SCORECARD/);
});

test("window and UTC inputs reject normalization surprises", () => {
  for (const windowDays of [undefined, 1, "7", 31]) assert.throws(() => buildScorecard({ windowDays }), /INVALID_WINDOW_DAYS/);
  for (const cutoffUtc of ["2026-10-20", "2026-10-20T00:00:00+00:00", "2026-02-30T00:00:00Z", "1970-01-01T00:00:00Z"]) {
    assert.throws(() => score([], [], { cutoffUtc }), /INVALID_/);
  }
});
