"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { Interface } = require("../node_modules/ethers");
const index = require("../lib/compound-borrower-index"), watch = require("../compound-v3-base-watch");
const { MARKET, CHAIN_ID, TOPICS, SEED_SCHEMA, MAX_SEED_BYTES } = index;
const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const hex = (n) => `0x${n.toString(16)}`;
const PIN = { number: 1048576, hash: `0x${"a".repeat(64)}`, timestamp: 1792016384 };
const EVENTS = new Interface(["event Withdraw(address indexed src,address indexed to,uint256 amount)", "event Transfer(address indexed from,address indexed to,uint256 amount)"]);
const MULTI = new Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] returnData)"]);
const GETTERS = new Interface(["function totalBorrow() view returns(uint256)", "function borrowBalanceOf(address) view returns(uint256)", "function isLiquidatable(address) view returns(bool)"]);
const seed = (users = [], extra = {}) => ({ schema: SEED_SCHEMA, updatedAt: "2020-01-01T00:00:00.000Z", chainId: CHAIN_ID, market: MARKET,
  pin: { ...PIN, number: PIN.number - 10000, hash: hash(99), timestamp: PIN.timestamp - 20000 }, users, ...extra });
const bytes = (value) => Buffer.from(JSON.stringify(value));
function log(user = addr(1), block = PIN.number, n = 1, event = "Withdraw") {
  return { address: MARKET, removed: false, blockNumber: hex(block), blockHash: block === PIN.number ? PIN.hash : hash(block), transactionHash: hash(n),
    logIndex: hex(n), ...EVENTS.encodeEventLog(EVENTS.getEvent(event), [user, addr(90), 1]) };
}
function transport({ logs = [], failAt = null, transform = (x) => x, drift = false } = {}) {
  const requests = []; let headers = 0;
  const send = async (method, params) => {
    requests.push({ method, params });
    if (method === "eth_chainId") return hex(CHAIN_ID);
    if (method === "eth_getBlockByNumber") {
      headers++;
      return { number: hex(PIN.number), timestamp: hex(PIN.timestamp), hash: drift && headers > 1 ? hash(3) : PIN.hash };
    }
    assert.equal(method, "eth_getLogs");
    assert.equal(params[0].address, MARKET); assert.deepEqual(params[0].topics, [TOPICS]);
    const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock));
    if (from === failAt) throw new Error("synthetic upstream failure; must not appear in output");
    return transform(logs.filter((l) => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to));
  };
  return { send, requests };
}
async function scan(options = {}, left = {}, right = left) {
  const a = transport(left), b = transport(right);
  return index.scanBorrowerIndex({ transports: [a.send, b.send], pin: PIN, ...options });
}
function liveFixture(fixture, { filter = () => true, failGetter = null } = {}) {
  const setup = watch.fixtureSetup(fixture);
  const send = async (method, params, ...rest) => {
    const value = await setup.send(method, params, ...rest);
    if (method === "eth_getLogs") return value.filter(filter);
    if (method !== "eth_call" || !failGetter) return value;
    const [calls] = MULTI.decodeFunctionData("aggregate3", params[0].data), [results] = MULTI.decodeFunctionResult("aggregate3", value);
    return MULTI.encodeFunctionResult("aggregate3", [results.map((r, i) => calls[i].callData.slice(0, 10) === GETTERS.getFunction(failGetter).selector ? [false, "0x"] : [r.success, r.returnData])]);
  };
  return { send, requests: setup.requests };
}
async function capture(fixture, options = {}, transforms = {}) {
  const a = liveFixture(fixture, transforms), b = liveFixture(fixture, transforms);
  return watch.capture({ mode: "live", transports: [a.send, b.send], seedBytes: bytes(seed()), maxRequests: 100, ...options });
}

const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); }; });
test.after(() => { globalThis.fetch = originalFetch; });

test("all 18 existing offline checks pass without persisting reports", async () => {
  const report = await watch.offlineTest({ persistReport: false, quiet: true });
  assert.equal(report.total, 18); assert.equal(report.passCount, 18);
});
test("legacy seed is strictly validated, deduplicated, hashed only after sanitization, and always partial", () => {
  const raw = bytes(seed([addr(10), addr(10).toUpperCase().replace("0X", "0x"), addr(2)], { blocksScanned: 120000, activeBorrowerCount: 1 }));
  const loaded = index.parseSeed(raw);
  assert.deepEqual(loaded.users, [addr(2), addr(10)]);
  assert.equal(loaded.provenance.candidateCount, 2);
  assert.equal(loaded.provenance.sha256, crypto.createHash("sha256").update(raw).digest("hex"));
  assert.equal(loaded.provenance.coverage, "PARTIAL"); assert.equal(loaded.provenance.coverageClaimsTrusted, false); assert.equal(loaded.provenance.legacyHintsOnly, true);
});
test("corrupt, wrong-schema, wrong-chain, wrong-market and invalid-address seeds fail closed", () => {
  for (const raw of ["{", "null", bytes(seed([], { schema: "unknown" })), bytes(seed([], { chainId: 1 })), bytes(seed([], { market: addr(9) })),
    bytes(seed(["invalid"])), bytes(seed([addr(0)])), bytes(seed([], { users: {} })), bytes(seed([], { extra: "not permitted" }))]) {
    assert.throws(() => index.parseSeed(raw), /SEED_INVALID/);
  }
});
test("finite timestamp/pin and byte/candidate caps are enforced", () => {
  for (const changed of [{ updatedAt: "not-a-date" }, { pin: { ...PIN, number: -1 } }, { pin: { ...PIN, timestamp: Infinity } },
    { pin: { ...PIN, hash: "invalid" } }, { blocksScanned: -2 }, { totalDiscoveredDebtUsdc: Infinity }]) assert.throws(() => index.parseSeed(bytes(seed([], changed))), /SEED_INVALID/);
  assert.throws(() => index.parseSeed(Buffer.alloc(MAX_SEED_BYTES + 1)), /SEED_BOUND_EXCEEDED/);
  assert.throws(() => index.parseSeed(bytes(seed([addr(1), addr(2)])), { candidateCap: 1 }), /SEED_BOUND_EXCEEDED/);
});
test("seed loader bounds file reads and treats legacy scan counters as untrusted hints", (t) => {
  const fs = require("node:fs"), raw = bytes(seed(Array.from({ length: 21 }, (_, i) => addr(i + 1)), { blocksScanned: 120000, candidatesChecked: 183, activeBorrowerCount: 21 }));
  let position = 0, closed = false;
  t.mock.method(fs, "openSync", () => 123);
  t.mock.method(fs, "fstatSync", () => ({ size: raw.length }));
  t.mock.method(fs, "readSync", (_fd, buffer, offset, length) => { const count = raw.copy(buffer, offset, position, Math.min(raw.length, position + length)); position += count; return count; });
  t.mock.method(fs, "closeSync", () => { closed = true; });
  const loaded = index.loadSeed("synthetic-seed.json");
  assert.equal(loaded.users.length, 21); assert.equal(loaded.provenance.coverageClaimsTrusted, false); assert.equal(closed, true);
  assert.equal(loaded.provenance.coveredBlocks, undefined);
  fs.fstatSync.mock.mockImplementation(() => ({ size: MAX_SEED_BYTES + 1 }));
  assert.throws(() => index.loadSeed("synthetic-seed.json"), /SEED_BOUND_EXCEEDED/);
  fs.openSync.mock.mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  assert.equal(index.loadSeed("synthetic-seed.json", { optional: true }), null);
  assert.throws(() => index.loadSeed("synthetic-seed.json"), /SEED_READ_FAILED/);
});
test("capture rejects a corrupt seed before any RPC", async () => {
  let calls = 0;
  const value = await watch.capture({ mode: "live", transports: [async () => { calls++; }, async () => { calls++; }], seedBytes: "{" });
  assert.equal(value.reason, "SEED_INVALID"); assert.equal(calls, 0); assert.equal(value.coverage.candidateDebtRaw, null);
});
test("live capture and index require two distinct supplied transports, with no fallback", async () => {
  const send = async () => { throw new Error("must not call"); };
  const value = await watch.capture({ mode: "live", send });
  assert.equal(value.reason, "DUAL_PROVIDER_REQUIRED"); assert.equal(value.diagnostics.rpcCount, 0);
  await assert.rejects(index.scanBorrowerIndex({ transports: [send, send], pin: PIN }), /DUAL_PROVIDER_REQUIRED/);
});
test("ABI topics, normalization, deduplication and zero-debt candidate retention", async () => {
  assert.deepEqual(TOPICS, [EVENTS.getEvent("Withdraw").topicHash, EVENTS.getEvent("Transfer").topicHash]);
  const logs = [log(addr(1)), log(addr(2), PIN.number, 2, "Transfer")];
  const result = await scan({ seedBytes: bytes(seed([addr(3)])) }, { logs: [...logs, logs[0]] }, { logs: logs.slice().reverse() });
  assert.equal(result.status, "COMPLETE"); assert.equal(result.coveredBlocks, 2000); assert.equal(result.successfulChunks, 1);
  assert.equal(result.logs.length, 2); assert.deepEqual(result.users, [addr(1), addr(2), addr(3)]);
  assert.equal(result.fullHistoryEstablished, false); assert.equal(result.coverage, "PARTIAL");
  assert.deepEqual(index.parseSeed(bytes(result)).users, result.users);
});
test("failed chunk records a gap without advancing cursor or covered counts", async () => {
  const start = PIN.number - 5;
  const result = await scan({ windowBlocks: 6, chunkBlocks: 2 }, { failAt: start + 2 }, {});
  assert.equal(result.status, "INCOMPLETE"); assert.equal(result.pinVerified, true);
  assert.equal(result.successfulChunks, 1); assert.equal(result.coveredBlocks, 2); assert.equal(result.nextCursor, start + 2);
  assert.deepEqual(result.gaps, [{ fromBlock: start + 2, toBlock: start + 3, reason: "RPC_FAILURE" }]);
  assert.ok(!JSON.stringify(result).includes("synthetic upstream"));
  assert.doesNotThrow(() => index.parseSeed(bytes(result)));
});
test("dual-provider log identities/data mismatch cannot commit a chunk", async () => {
  const row = log();
  for (const other of [[], [{ ...row, data: `0x${"0".repeat(63)}2` }], [{ ...row, transactionHash: hash(4) }]]) {
    const result = await scan({}, { logs: [row] }, { logs: other });
    assert.equal(result.reason, "LOG_MISMATCH"); assert.equal(result.successfulChunks, 0); assert.equal(result.coveredBlocks, 0);
    assert.equal(result.nextCursor, PIN.number - 1999); assert.deepEqual(result.users, []);
  }
});
test("invalid log address/topics/block/removed/data and conflicting identity reject the entire chunk", async () => {
  const row = log();
  for (const changed of [{ address: addr(9) }, { removed: true }, { blockHash: hash(4) }, { blockNumber: hex(PIN.number + 1) },
    { topics: [hash(1), ...row.topics.slice(1)] }, { topics: [row.topics[0], hash(1).replace("0x0", "0xf"), row.topics[2]] }, { data: "0x" }]) {
    const result = await scan({}, { logs: [row], transform: () => [{ ...row, ...changed }] });
    assert.equal(result.successfulChunks, 0); assert.equal(result.status, "INCOMPLETE"); assert.equal(result.gaps.length, 1);
  }
  const conflict = await scan({}, { logs: [row, { ...row, data: hash(2) }] });
  assert.equal(conflict.reason, "READ_INVALID"); assert.equal(conflict.coveredBlocks, 0);
});
test("candidate/log caps fail transactionally instead of silently truncating", async () => {
  const result = await scan({ candidateCap: 1, seedBytes: bytes(seed([addr(1)])) }, { logs: [log(addr(2))] });
  assert.equal(result.reason, "DISCOVERY_BOUND_EXCEEDED"); assert.equal(result.nextCursor, PIN.number - 1999);
  assert.deepEqual(result.users, [addr(1)]); assert.equal(result.coveredBlocks, 0);
  const tooMany = await scan({}, { logs: Array(5001).fill(log()) });
  assert.equal(tooMany.reason, "DISCOVERY_BOUND_EXCEEDED"); assert.equal(tooMany.successfulChunks, 0);
});
test("bounded cursor/evidence round trips and resumes only the unscanned tail", async () => {
  const first = await scan({ windowBlocks: 6, chunkBlocks: 2, maxChunks: 1 });
  assert.equal(first.status, "INCOMPLETE"); assert.equal(first.nextCursor, PIN.number - 3); assert.equal(first.coveredBlocks, 2);
  const next = await scan({ seedBytes: bytes(first), windowBlocks: 6, chunkBlocks: 2, maxChunks: 2 });
  assert.equal(next.status, "COMPLETE"); assert.equal(next.coveredBlocks, 6); assert.equal(next.successfulChunks, 3);
  assert.equal(next.nextCursor, PIN.number + 1); assert.equal(next.fullHistoryEstablished, false);
  const forged = structuredClone(first); forged.coveredBlocks = 6;
  assert.throws(() => index.parseSeed(bytes(forged)), /SEED_INVALID/);
});
test("failed gap can be retried at the exact cursor, not skipped", async () => {
  const start = PIN.number - 5;
  const failed = await scan({ windowBlocks: 6, chunkBlocks: 2 }, { failAt: start + 2 }, {});
  const a = transport(), b = transport();
  const next = await index.scanBorrowerIndex({ transports: [a.send, b.send], pin: PIN, seedBytes: bytes(failed), windowBlocks: 6, chunkBlocks: 2 });
  assert.equal(a.requests.find((r) => r.method === "eth_getLogs").params[0].fromBlock, hex(start + 2));
  assert.equal(next.status, "COMPLETE"); assert.equal(next.coveredBlocks, 6); assert.deepEqual(next.gaps, []);
});
test("index persistence includes validated cursor/evidence and is non-overwriting by default", async (t) => {
  const result = await scan({ windowBlocks: 6, chunkBlocks: 2, maxChunks: 1 });
  const fs = require("node:fs"); let written, linked = false, renamed = false;
  for (const name of ["mkdirSync", "fsyncSync", "closeSync", "unlinkSync"]) t.mock.method(fs, name, () => {});
  t.mock.method(fs, "openSync", (_file, flags) => { assert.equal(flags, "wx"); return 123; });
  t.mock.method(fs, "writeFileSync", (_fd, data) => { written = data; });
  t.mock.method(fs, "linkSync", () => { linked = true; });
  t.mock.method(fs, "renameSync", () => { renamed = true; });
  const saved = index.persistBorrowerIndex("synthetic-index.json", result);
  assert.equal(linked, true); assert.equal(renamed, false); assert.equal(saved.bytes, written.length);
  const loaded = index.parseSeed(written);
  assert.equal(loaded.document.nextCursor, PIN.number - 3); assert.deepEqual(loaded.document.coveredRanges, result.coveredRanges);
  fs.linkSync.mock.mockImplementation(() => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); });
  assert.throws(() => index.persistBorrowerIndex("synthetic-index.json", result), { code: "EEXIST" });
});
test("standalone time budget expires without turning requests into coverage", async () => {
  let tick = 0;
  const result = await scan({ maxMs: 1, now: () => tick++ });
  assert.equal(result.reason, "TIME_BUDGET_EXCEEDED"); assert.equal(result.coveredBlocks, 0); assert.equal(result.nextCursor, PIN.number - 1999);
});
test("terminal canonical pin drift invalidates coverage and cursor advancement", async () => {
  const result = await scan({}, { logs: [log()], drift: true }, { logs: [log()] });
  assert.equal(result.reason, "PIN_DRIFT"); assert.equal(result.pinVerified, false); assert.equal(result.coveredBlocks, 0);
  assert.equal(result.successfulChunks, 0); assert.equal(result.nextCursor, PIN.number - 1999);
});
test("backfill is explicit and bounded; a newer seed pin is rejected", async () => {
  await assert.rejects(scan({ fromBlock: PIN.number - 20, windowBlocks: 10 }), /INDEX_INVALID/);
  const result = await scan({ fromBlock: PIN.number - 20, windowBlocks: 10, chunkBlocks: 2, maxChunks: 2, backfill: true });
  assert.equal(result.window.toBlock, PIN.number - 11); assert.equal(result.coveredBlocks, 4);
  await assert.rejects(scan({ seedBytes: bytes(seed([], { pin: { ...PIN, number: PIN.number + 1 } })) }), /SEED_PIN_AHEAD/);
  assert.throws(() => watch.parseArgs(["--window-blocks", "120001"]), /INVALID_ARGUMENTS/);
  const options = watch.parseArgs(["--backfill", "--from-block", "1", "--window-blocks", "20", "--chunk-blocks", "2", "--max-chunks", "3"]);
  assert.equal(options.backfill, true); assert.equal(options.maxChunks, 3);
});
test("seed borrower outside recent window is screened; topN is display-only and coverage is same-pin", async () => {
  const value = await capture({ marketDebt: "4000000", rows: [{ debt: "1000000", collateral: "1125000" }, { debt: "2000000", collateral: "5000000" }, { debt: "0" }] },
    { topN: 1, seedBytes: bytes(seed([addr(1), addr(3)])) }, { filter: (l) => l.topics[1].endsWith(addr(2).slice(2)) });
  assert.equal(value.status, "COMPLETE"); assert.equal(value.borrowers.length, 1); assert.equal(value.borrowers[0].user, addr(2));
  assert.equal(value.screenedBorrowers.length, 2); assert.equal(value.closestToLiquidation.user, addr(1)); assert.equal(value.closestToLiquidation.verdict, "LIQUIDATABLE");
  assert.equal(value.crossSectionSummary.nonZeroObservationsForReview[0].user, addr(1));
  assert.equal(value.discovery.rankingEstablishedWithinWindow, false); assert.equal(value.discovery.rankingEstablishedWithinDiscoveredSet, true);
  assert.equal(value.borrowers[0].debtRankWithinWindow, null); assert.equal(value.borrowers[0].debtRankWithinDiscoveredSet, 1);
  assert.equal(value.discovery.seed.staleAtPin, true); assert.equal(value.discovery.seed.coverageClaimsTrusted, false);
  assert.equal(value.coverage.candidateDebtRaw, "3000000"); assert.equal(value.coverage.screenedDebtRaw, "3000000");
  assert.equal(value.coverage.marketTotalDebtRaw, "4000000"); assert.equal(value.coverage.candidateDebtCoverageFraction, "0.750000000000000000");
  assert.equal(value.coverage.debtResidualRaw, "1000000"); assert.equal(value.coverage.unscreenedActiveCount, 0); assert.equal(value.coverage.fullMarketCoverageEstablished, false);
  assert.equal(value.coverage.pin.hash, value.pin.hash); assert.equal(value.borrowerIndex.users.includes(addr(3)), true);
});
test("topN zero still screens all discovered active positions", async () => {
  const value = await capture({ rows: [{ collateral: "1125000" }] }, { topN: 0 });
  assert.equal(value.status, "COMPLETE"); assert.deepEqual(value.borrowers, []); assert.equal(value.screenedBorrowers.length, 1);
  assert.equal(value.crossSectionSummary.nonZeroObservationsForReview.length, 1);
});
test("explicit position cap reports unscreened count, never healthy lower-debt placeholders", async () => {
  const value = await capture({ rows: [{ debt: "2000000", collateral: "5000000" }, { debt: "1000000", collateral: "1125000" }] }, { screenCap: 1 });
  assert.equal(value.status, "INCOMPLETE"); assert.equal(value.coverage.unscreenedActiveCount, 1);
  assert.equal(value.borrowers[1].verdict, "INCOMPLETE"); assert.equal(value.borrowers[1].reason, "SCREEN_CAP_REACHED");
  assert.equal(value.coverage.screenedDebtRaw, null); assert.equal(value.coverage.knownScreenedDebtRaw, "2000000");
});
test("failed debt reads remain unknown while same-pin market totals are retained", async () => {
  const value = await capture({ rows: [{ failure: "borrowBalanceOf" }, { debt: "2000000" }] });
  assert.equal(value.status, "INCOMPLETE"); assert.equal(value.reason, "RANKING_INCOMPLETE"); assert.equal(value.coverage.debtReadFailedCount, 1);
  assert.equal(value.coverage.candidateDebtRaw, null); assert.equal(value.coverage.candidateDebtCoverageFraction, null); assert.equal(value.coverage.debtResidualRaw, null);
  assert.equal(value.coverage.marketTotalDebtRaw, "3000000"); assert.equal(value.coverage.marketDebtReadStatus, "COMPLETE");
  assert.equal(value.discovery.candidates[0].debtRaw, null); assert.equal(value.discovery.rankingEstablishedWithinDiscoveredSet, false);
});
test("market-total failure does not become zero or prevent full position screening", async () => {
  const value = await capture({ rows: [{ collateral: "1125000" }] }, {}, { failGetter: "totalBorrow" });
  assert.equal(value.status, "INCOMPLETE"); assert.equal(value.coverage.marketTotalDebtRaw, null); assert.equal(value.coverage.marketDebtReadStatus, "INCOMPLETE");
  assert.equal(value.coverage.candidateDebtCoverageFraction, null); assert.equal(value.coverage.debtResidualRaw, null);
  assert.equal(value.screenedBorrowers[0].verdict, "LIQUIDATABLE");
});
test("isLiquidatable failure is incomplete rather than healthy or zero debt", async () => {
  const value = await capture({ rows: [{ failure: "isLiquidatable" }] });
  assert.equal(value.status, "INCOMPLETE"); assert.equal(value.borrowers[0].verdict, "INCOMPLETE"); assert.equal(value.closestToLiquidation, null);
  assert.equal(value.coverage.unscreenedActiveCount, 1); assert.equal(value.coverage.screenedDebtRaw, null);
});
test("state responses must also agree across providers", async () => {
  const a = liveFixture({ rows: [{}] }), b = liveFixture({ rows: [{ debt: "2000000" }] });
  const value = await watch.capture({ mode: "live", transports: [a.send, b.send], seedBytes: bytes(seed()), maxRequests: 100 });
  assert.equal(value.status, "INCOMPLETE"); assert.equal(value.coverage.candidateDebtRaw, null); assert.equal(value.coverage.marketTotalDebtRaw, null);
  assert.equal(value.closestToLiquidation, null);
});
test("request exhaustion is incomplete and respects the hard budget", async () => {
  const value = await capture({ rows: [{}] }, { maxRequests: 8 });
  assert.equal(value.status, "INCOMPLETE"); assert.equal(value.reason, "RPC_BUDGET_EXCEEDED"); assert.equal(value.diagnostics.rpcCount, 8);
  assert.equal(value.coverage.screenedDebtRaw, null); assert.equal(value.coverage.marketTotalDebtRaw, null);
});
