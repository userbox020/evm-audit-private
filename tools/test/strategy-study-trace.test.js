"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { Interface, AbiCoder, keccak256 } = require("ethers");
const capture = require("../strategy-study/capture");
const t1 = require("../strategy-study/trace-enrichment");
const cli = require("../strategy-study/trace-cli");
const accounting = require("../strategy-study/call-accounting");
const H = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`, Q = n => `0x${BigInt(n).toString(16)}`;
const A = `0x${"11".repeat(20)}`, B = `0x${"22".repeat(20)}`, SENTINEL = "RAW_PRIVATE_SENTINEL_NEVER_PUBLISH";
const C = `0x${"33".repeat(20)}`, D = `0x${"44".repeat(20)}`, E = `0x${"55".repeat(20)}`;
const BUY = new Interface(["function buyCollateral(address,uint256,uint256,address)"]);
const LIQUIDATE = new Interface(["function liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes) returns (uint256,uint256)"]);
const CALLBACK = `0x${Buffer.from(SENTINEL).toString("hex")}`, MARKET = [A, B, D, E, 860000000000000000n];
const buyInput = (recipient = E) => BUY.encodeFunctionData("buyCollateral", [C, 17, 19, recipient]);
const morphoInput = (callback = CALLBACK) => LIQUIDATE.encodeFunctionData("liquidate", [MARKET, D, 23, 29, callback]);
const morphoOutput = () => LIQUIDATE.encodeFunctionResult("liquidate", [31, 37]);
const START = Date.parse("2026-10-20T05:00:00Z"), clone = value => structuredClone(value);
function fixture(options = {}) {
  const n = options.n || 3, calls = [], origins = [], candidates = options.candidates || ["https://eth-mainnet.g.alchemy.com/offline", "https://eth-mainnet.infura.io/offline", "https://ethereum.publicnode.com/offline"];
  let clock = START;
  const hash = u => H(10000 + u), blockNumber = u => 100 + u, uHash = value => Number(BigInt(value) - 10000n);
  function block(number) { return { number: Q(number), hash: H(number), parentHash: H(number - 1), stateRoot: H(number + 2000),
    timestamp: Q(1791849600 + number * 12), transactions: number >= 100 && number < 100 + n ? [hash(number - 100)] : [], ignored: SENTINEL }; }
  function tx(u) { return { hash: hash(u), blockHash: H(blockNumber(u)), blockNumber: Q(blockNumber(u)), transactionIndex: "0x0", from: A, to: B,
    type: options.type || "0x2", nonce: Q(u), gas: "0x5208", value: "0x0", input: options.input || "0x1234", chainId: "0x1", ignored: SENTINEL }; }
  function receipt(u) { return { transactionHash: hash(u), blockHash: H(blockNumber(u)), blockNumber: Q(blockNumber(u)), transactionIndex: "0x0", from: A, to: B,
    type: options.type || "0x2", status: "0x1", gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x2", contractAddress: null,
    logs: (options.logAddresses || [B, B]).map((address, i) => ({ address, topics: [H(i + 1)], data: "0x1234", blockHash: H(blockNumber(u)), blockNumber: Q(blockNumber(u)),
      transactionHash: hash(u), transactionIndex: "0x0", logIndex: Q(i + (options.logOffset ?? 10)), removed: false })), ignored: SENTINEL }; }
  function callTrace(u) {
    const raw = { type: "CALL", from: A, to: B, value: "0x0", gas: "0x5208", gasUsed: "0x5208", input: options.input || "0x1234", output: "0x",
      logs: receipt(u).logs.map(({ address, topics, data }, i) => ({ address, topics, data, position: "0x0", ...(options.metadata ? { index: Q(i) } : {}) })) };
    return options.trace ? options.trace(raw, u) : raw;
  }
  function state(u) { return { pre: { [A]: { balance: "0x64", nonce: u, storage: { "0x1": "0x3" }, ...(options.metadata ? { codeHash: H(10) } : {}) } },
    post: { [A]: { balance: "0x5a", nonce: u + 1, storage: { "0x1": "0x4" }, ...(options.metadata ? { codeHash: H(11) } : {}) } } }; }
  const authoritative = { manifestSha256: t1.C2_SHA256, authority: { validAggregate: true }, manifest: { status: "COMPLETE", chainId: 1, mode: "authorized-backoff", integrityFailure: false,
    finalAnchorRechecked: true, finality: { header: capture.normalizeHeader(block(1000)) }, counts: { uniqueTransactions: n }, window: { fromBlock: "100", toBlock: String(99 + n), startTimestamp: "1791849600", endTimestampExclusive: "1792454400" } },
  chunks: [{ sourceId: "aave-v3", logs: Array.from({ length: n }, (_, u) => capture.normalizeReceipt(receipt(u)).logs).flat(),
    transactions: Array.from({ length: n }, (_, u) => capture.normalizeTransaction(tx(u))), receiptEvidence: Array.from({ length: n }, (_, u) => capture.normalizeReceipt(receipt(u))),
    headers: Array.from({ length: n }, (_, u) => capture.normalizeHeader(block(blockNumber(u)), true)) }] };
  for (const source of options.sources || []) authoritative.chunks.push({ sourceId: source.sourceId,
    logs: authoritative.chunks[0].logs.filter(log => source.addresses.includes(log.address)), transactions: [], receiptEvidence: [], headers: [] });
  const parent = t1.prepareParent(authoritative, n);
  const result = { calls, origins, candidates, authoritative, parent, hash, block, tx, receipt, callTrace, state,
    setNow: value => { clock = value; }, now: () => clock };
  result.options = { candidates, shared: { getOrigin: () => "https://owned-origin.invalid", loadRpcUrls() { throw new Error("INVENTORY_FORBIDDEN"); } },
    now: () => clock, sleep: async ms => { const until = clock + ms; await Promise.resolve(); clock = Math.max(clock, until); }, backoffRandom: () => 0,
    ...(options.limits ? { limits: options.limits } : {}), fetch: async (url, init) => {
      const req = JSON.parse(init.body), index = candidates.indexOf(url), u = ["eth_getTransactionByHash", "eth_getTransactionReceipt", "debug_traceTransaction"].includes(req.method) ? uHash(req.params[0]) : null;
      const call = { index, method: req.method, params: req.params, u }; calls.push(clone(call)); origins.push(init.headers.Origin);
      assert.equal(init.redirect, "error");
      let raw;
      switch (req.method) {
        case "eth_chainId": raw = "0x1"; break;
        case "eth_getBlockByNumber": raw = block(req.params[0] === "finalized" ? 1001 : Number(BigInt(req.params[0]))); break;
        case "eth_getBlockByHash": raw = block(Number(BigInt(req.params[0]))); break;
        case "eth_getTransactionByHash": raw = tx(u); break;
        case "eth_getTransactionReceipt": raw = receipt(u); break;
        case "debug_traceTransaction": raw = req.params[1].tracer === "callTracer" ? callTrace(u) : state(u); break;
        default: assert.fail("forbidden method");
      }
      const response = options.hook ? await options.hook({ ...call, result: raw, fixture: result }) || {} : {};
      return new Response(response.raw === undefined ? JSON.stringify({ jsonrpc: "2.0", id: req.id,
        ...(response.error ? { error: response.error } : { result: Object.hasOwn(response, "result") ? response.result : raw }) }) : response.raw,
      { status: response.status || 200, headers: response.headers });
    } };
  return result;
}
const run = (f, extra = {}) => t1.runEnrichment({ parent: f.parent, runtimeOptions: f.options, ...extra });
const isCall = call => call.method === "debug_traceTransaction" && call.params[1].tracer === "callTracer";
const isState = call => call.method === "debug_traceTransaction" && call.params[1].tracer === "prestateTracer";
function temp() { const root = path.join(os.tmpdir(), "opencode"); fs.mkdirSync(root, { recursive: true }); return fs.mkdtempSync(path.join(root, "t1-test-")); }
function read(out, f, options = {}) { return cli.readAuthoritativeTraces(out, options, { loadParent: () => f.parent }); }
async function published(f) {
  const root = temp(), out = path.join(root, "capture"), writer = cli.createTraceWriter(out);
  const result = await run(f, { onTrace: writer.onTrace }), summary = writer.publish(result, f.parent, f.now);
  return { root, out, result, summary };
}
function accountingFixture(options = {}) {
  return fixture({ ...options, input: options.input || buyInput(), logAddresses: [B, C],
    sources: options.sources || [{ sourceId: "compound-iii", addresses: [B] }, { sourceId: "morpho-blue", addresses: [C] }],
    trace(raw, u) {
      raw.calls = [{ type: "CALL", from: B, to: C, value: "0x0", gas: "0x1000", gasUsed: "0x100", input: morphoInput(), output: morphoOutput(), logs: [raw.logs.pop()] }];
      return options.accountingTrace ? options.accountingTrace(raw, u) : raw;
    },
  });
}

module.exports = { fixture, accountingFixture };
// Reuse the same offline transport in T1D tests without registering this suite twice.
if (require.main === module) {
test("T1 parent loader binds the fixed C2 digest and full 111-item authority before use", () => {
  const census = require("../strategy-study/census-cli"), original = census.readAuthoritativeCensus, f = fixture({ n: 111 });
  try {
    census.readAuthoritativeCensus = (directory, options) => {
      assert.equal(directory, t1.C2_DIRECTORY); assert.deepEqual(options, { allowPartial: false, expectedManifestSha256: t1.C2_SHA256 }); return f.authoritative;
    };
    assert.equal(t1.loadParent().universe.length, 111);
    census.readAuthoritativeCensus = () => ({ ...f.authoritative, manifestSha256: "0".repeat(64) });
    assert.throws(t1.loadParent, /invalid-schema/);
    census.readAuthoritativeCensus = () => fixture().authoritative;
    assert.throws(t1.loadParent, /invalid-schema/);
  } finally { census.readAuthoritativeCensus = original; }
});

test("T1 full pool qualifies both capabilities, reuses the first fixture and collects only its immutable pair", async () => {
  const f = fixture({ metadata: true }), r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason); assert.equal(r.integrityFailure, null); assert.equal(r.runtimeDrained, true); assert.equal(r.finalAnchorRechecked, true);
  assert.equal(r.schema, "strategy-study-t1/v1");
  for (const field of ["diagnostic", "diagnosticConstruction", "validAggregate", "indexSemantics", "indexProvenance"]) assert.equal(Object.hasOwn(r, field), false);
  assert.deepEqual(r.counts, { universe: 3, completed: 3, missing: 0 }); assert.deepEqual(r.missingIndices, []); assert.deepEqual(r.selectedAliases, ["obs-01", "obs-02"]);
  const firstTrace = f.calls.findIndex(c => c.method === "debug_traceTransaction"), firstNext = f.calls.findIndex(c => c.u === 1);
  for (let i = 0; i < 3; i++) {
    assert.ok(f.calls.findIndex(c => c.index === i && c.method === "eth_getTransactionReceipt") < firstTrace);
    assert.ok(f.calls.findIndex(c => c.index === i && isState(c)) < firstNext);
    assert.equal(f.calls.filter(c => c.index === i && c.u === 0 && c.method === "debug_traceTransaction").length, 2);
  }
  assert.ok(f.calls.slice(firstNext).every(c => c.index < 2));
  assert.equal(r.budget.traceRequests, 6 + 4 * 2); assert.equal(r.budget.logRequests, 0); assert.equal(r.budget.requests, f.calls.length);
  assert.equal(r.transportDiagnostics.length, f.calls.length); assert.ok(r.transportDiagnostics.every(d => t1.PHASES.includes(d.phase) && d.httpStatus === 200));
  assert.deepEqual(r.traces[0].metadataCoverage, { logIndex: { total: 2, reportedBoth: 2, unknown: 0 }, codeHashSides: { total: 2, reportedBoth: 2, unknown: 0 } });
  assert.equal(r.traces[0].callFrames[0].logs[0].index, "0"); assert.equal(r.traces[0].receipt.logs[0].logIndex, "10");
  assert.ok(r.traces.every(row => row.profitKnown === false && row.costComplete === false && row.tokenBalanceLayoutVerified === false && row.traceReceiptBound));
  assert.deepEqual(r.limits, capture.ENRICHMENT_LIMITS); assert.equal(r.backoff.activeOperations, 0); assert.equal(r.backoff.pendingRuns, 0);
  assert.ok(!/RAW_PRIVATE|https:|owned-origin|alchemy|infura|publicnode/.test(JSON.stringify(r)));
});

test("T1 full 111-item universe fits fixed physical/trace caps without forbidden methods or horizon probes", async () => {
  const f = fixture({ n: 111 }), r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason); assert.equal(r.traces.length, 111); assert.equal(r.budget.traceRequests, 446);
  assert.ok(r.budget.requests < 3000 && r.budget.traceRequests <= 512 && r.budget.bytes < 256 * 1024 * 1024);
  assert.equal(r.limits.traceRequestCap, 512); assert.equal(r.limits.traceConcurrency, 1); assert.equal(r.limits.concurrency, 2);
  assert.ok(f.calls.every(c => capture.ENRICHMENT_METHODS.includes(c.method)));
  assert.ok(f.calls.filter(c => c.method === "debug_traceTransaction").every(c => [capture.canonical(capture.CALL_CONFIG), capture.canonical(capture.PRESTATE_CONFIG)].includes(capture.canonical(c.params[1]))));
});

test("metadata missing from one selected provider remains unknown, not a semantic conflict or corroborated value", async () => {
  const f = fixture({ metadata: true, hook(c) {
    if (c.index === 1 && isCall(c)) c.result.logs.forEach(log => { delete log.index; });
    if (c.index === 1 && isState(c)) delete c.result.post[A].codeHash;
    return { result: c.result };
  } }), p = await published(f);
  try {
    assert.equal(p.result.status, "COMPLETE", p.result.reason); const row = read(p.out, f).traces[0];
    assert.equal(Object.hasOwn(row.callFrames[0].logs[0], "index"), false);
    assert.deepEqual(row.stateAccounts[0].codeHash, { before: H(10), after: null });
    assert.deepEqual(row.metadataCoverage, { logIndex: { total: 2, reportedBoth: 0, unknown: 2 }, codeHashSides: { total: 2, reportedBoth: 1, unknown: 1 } });
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("optional metadata conflicts across eligible candidates stay fatal even when an earlier candidate later retires", async () => {
  for (const kind of ["call", "state"]) {
    const f = fixture({ metadata: true, hook(c) {
      if (c.index === 0 && isCall(c) && kind === "call") c.result.logs[0].index = "0x9";
      if (c.index === 0 && isState(c) && kind === "state") c.result.pre[A].codeHash = H(999);
      if (c.index === 0 && ((kind === "call" && isState(c)) || (kind === "state" && c.method === "eth_getTransactionReceipt" && c.fixture.calls.some(isState)))) return { status: 403, raw: SENTINEL };
      return { result: c.result };
    } }), r = await run(f);
    assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.traces.length, 0);
    assert.equal(r.aggregateEvidenceStatus, "INVALID"); assert.equal(r.observations[0][kind], "passed");
  }
});

test("core frame/native/nonce/storage/depth/error disagreement is never ignored as optional metadata", async () => {
  for (const field of ["gas", "balance", "nonce", "storage"]) {
    const f = fixture({ hook(c) {
      if (c.index === 1 && isCall(c) && field === "gas") c.result.gas = "0x5209";
      if (c.index === 1 && isState(c)) {
        if (field === "balance") c.result.pre[A].balance = "0x65";
        if (field === "nonce") c.result.pre[A].nonce = 9;
        if (field === "storage") c.result.pre[A].storage["0x1"] = "0x5";
      }
      return { result: c.result };
    } }), r = await run(f);
    assert.equal(r.reason, "consensus-mismatch", field); assert.equal(r.aggregateEvidenceStatus, "INVALID");
  }
});

test("matching empty/no-op or sender-unbound diffs cannot qualify, including omitted unchanged post nonce", async () => {
  for (const mode of ["empty", "noop", "missing-sender", "missing-before", "wrong-before", "unchanged-after", "empty-post", "absent-post"]) {
    const f = fixture({ hook(c) {
      if (!isState(c)) return {};
      if (mode === "empty") return { result: { pre: {}, post: {} } };
      if (mode === "noop") c.result.post = clone(c.result.pre);
      if (mode === "missing-sender") { c.result.pre[B] = c.result.pre[A]; c.result.post[B] = c.result.post[A]; delete c.result.pre[A]; delete c.result.post[A]; }
      if (mode === "missing-before") delete c.result.pre[A].nonce;
      if (mode === "wrong-before") c.result.pre[A].nonce = c.u + 1;
      if (mode === "unchanged-after") c.result.post[A].nonce = c.u;
      if (mode === "empty-post") c.result.post[A] = {};
      if (mode === "absent-post") delete c.result.post[A];
      return { result: c.result };
    } }), r = await run(f);
    assert.equal(r.status, "CAPTURE-FAILED", mode); assert.equal(r.aggregateEvidenceStatus, "INVALID"); assert.equal(r.traces.length, 0);
    assert.equal(r.observations[0].state, "not-tested"); assert.equal(r.integrityFailure.phase, "prestate-tracer");
    assert.equal(r.reason, mode === "empty" ? "invalid-prestate" : "binding-mismatch");
  }
});

test("sender nonce progression needs no storage or negative balance; extra increments remain unreconciled for type 4 and other types", async () => {
  for (const [type, increment] of [["0x0", 1], ["0x1", 1], ["0x2", 1], ["0x3", 1], ["0x4", 3], ["0x2", 3]]) {
    const f = fixture({ type, hook(c) {
      if (!isState(c)) return {};
      delete c.result.pre[A].storage; delete c.result.post[A].storage;
      c.result.post[A].balance = "0x65";
      c.result.post[A].nonce = c.u + increment;
      return { result: c.result };
    } }), p = await published(f);
    try {
      assert.equal(p.result.status, "COMPLETE", `${type}: ${p.result.reason}`);
      assert.equal(read(p.out, f).authority.validAggregate, true);
      assert.ok(p.result.limitations.some(note => note.includes("minimum +1 progression") && note.includes("not full reconciliation")));
      assert.equal(p.result.traces[0].stateAccounts[0].nonce.after, String(increment));
      assert.deepEqual(p.result.traces[0].senderNonceSanity, { preNonce: "0", postNonce: String(increment), minimumProgression: true,
        extraIncrements: String(increment - 1), extraIncrementsStatus: increment > 1 ? "unreconciled" : "none" });
      assert.equal(p.result.traces[0].stateAccounts[0].storage.length, 0);
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});

test("wrong-chain stops before target reads; unavailable call tracer does not waste a prestate request", async () => {
  for (const mode of ["chain", "call"]) {
    const f = fixture({ hook(c) {
      if (c.index === 0 && c.method === "eth_chainId" && mode === "chain") return { result: "0x2" };
      if (c.index === 0 && isCall(c) && mode === "call") return { error: { code: -32601, message: SENTINEL } };
    } }), r = await run(f);
    assert.equal(r.status, "COMPLETE", r.reason); assert.deepEqual(r.selectedAliases, ["obs-02", "obs-03"]);
    if (mode === "chain") assert.equal(f.calls.filter(c => c.index === 0).length, 1);
    else assert.equal(f.calls.filter(c => c.index === 0 && isState(c)).length, 0);
  }
});

test("two independent basic providers are required before any trace, and a known-height finalized conflict is immediate", async () => {
  const singleFamily = fixture({ candidates: ["https://eth.alchemy.com/a", "https://eth.alchemy.com/b"] }), blocked = await run(singleFamily);
  assert.equal(blocked.reason, "independent-pair-unavailable"); assert.equal(blocked.budget.traceRequests, 0);
  const f = fixture({ hook(c) {
    if (c.method === "eth_getBlockByNumber" && c.params[0] === "finalized") return { result: { ...c.fixture.block(1000), stateRoot: H(999) } };
  } }), r = await run(f);
  assert.equal(r.reason, "consensus-mismatch"); assert.equal(f.calls.length, 2); assert.equal(r.integrityFailure.phase, "finalized-header");
});

test("same-family exhausted 429 circuit prevents a second credential call during qualification", async () => {
  const f = fixture({ candidates: ["https://eth.alchemy.com/first", "https://eth.alchemy.com/second", "https://eth.infura.io/offline", "https://ethereum.publicnode.com/offline"],
    hook: c => c.index === 0 ? { status: 429, raw: SENTINEL, headers: { "retry-after": "1" } } : {} }), r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason); assert.deepEqual(r.selectedAliases, ["obs-03", "obs-04"]);
  assert.equal(f.calls.filter(c => c.index === 0).length, 3); assert.equal(f.calls.filter(c => c.index === 1).length, 0);
  assert.equal(r.observations[1].reason, "provider-circuit-open"); assert.equal(r.backoff.retries, 2);
});

test("root, full-receipt log order and malformed trace metadata fail closed with structural-only diagnostics", async () => {
  for (const mode of ["root", "logs", "order", "index", "position", "codeHash", "shape"]) {
    const f = fixture({ hook(c) {
      if (isCall(c)) {
        if (mode === "root") c.result.from = B;
        if (mode === "logs") c.result.logs.pop();
        if (mode === "order") c.result.logs.reverse();
        if (mode === "index") c.result.logs[0].index = SENTINEL;
        if (mode === "position") { delete c.result.logs[0].position; c.result.logs[0].index = "0x0"; }
        if (mode === "shape") c.result[SENTINEL] = SENTINEL;
      }
      if (isState(c) && mode === "codeHash") c.result.pre[A].codeHash = SENTINEL;
      return { result: c.result };
    } }), r = await run(f);
    assert.equal(r.status, "CAPTURE-FAILED", mode); assert.equal(r.traces.length, 0);
    assert.ok(r.integrityFailure.diagnostics); assert.deepEqual(Object.keys(r.integrityFailure.diagnostics).sort(), ["category", "depth", "frameCount", "hasCalls", "hasLogs"].sort());
    assert.ok(!JSON.stringify(r).includes(SENTINEL));
  }
});

test("every typed C2 fact is checked immediately before a later availability failure can hide a contradiction", async () => {
  for (const kind of ["header", "transaction", "receipt", "finalized"]) {
    const f = fixture({ hook(c) {
      if (c.index !== 0) return {};
      if (kind === "header" && c.method === "eth_getBlockByNumber" && c.params[0] === Q(100)) c.result.stateRoot = H(999);
      if (kind === "transaction" && c.method === "eth_getTransactionByHash") c.result.nonce = "0x9";
      if (kind === "receipt" && c.method === "eth_getTransactionReceipt") c.result.gasUsed = "0x1";
      if (kind === "finalized" && c.method === "eth_getBlockByHash" && c.params[0] === H(1001)) c.result.stateRoot = H(999);
      return { result: c.result };
    } }), r = await run(f);
    assert.equal(r.status, "CAPTURE-FAILED", kind); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.traces.length, 0);
  }
});

test("selected-pair 429 retries only its failed leg; exhaustion terminates the exact prefix without replacement or skipped hashes", async () => {
  for (const recover of [true, false]) {
    let tries = 0;
    const f = fixture({ hook(c) { if (c.index === 0 && c.u === 1 && isCall(c) && (++tries === 1 || !recover)) return { status: 429, raw: SENTINEL, headers: { "retry-after": "1" } }; } }), r = await run(f);
    assert.equal(f.calls.filter(c => c.index === 1 && c.u === 1 && isCall(c)).length, 1);
    const retried = f.calls.filter(c => c.index === 0 && c.u === 1 && isCall(c));
    assert.equal(retried.length, recover ? 2 : 3); assert.deepEqual(retried[0], retried[1]);
    assert.equal(r.backoff.retries, recover ? 1 : 2); assert.equal(r.budget.requests, f.calls.length);
    assert.equal(r.budget.traceRequests, f.calls.filter(c => c.method === "debug_traceTransaction").length);
    assert.ok(r.transportDiagnostics.filter(d => d.httpStatus === 429).every(d => d.phase === "call-tracer" && d.universeIndex === 1));
    assert.ok(f.calls.filter(c => c.u > 0).every(c => c.index < 2));
    if (recover) assert.equal(r.status, "COMPLETE", r.reason);
    else { assert.equal(r.status, "ACCESS-BLOCKED"); assert.equal(r.traces.length, 1); assert.deepEqual(r.missingIndices, [1, 2]); assert.equal(f.calls.some(c => c.u === 2), false); }
  }
});

test("physical request/trace caps and global retry exhaustion are terminal, not candidate-local retirement", async () => {
  for (const limits of [{ requests: 1 }, { traceRequestCap: 1 }]) {
    const f = fixture({ limits }), r = await run(f);
    assert.equal(r.status, "LIMIT-REACHED"); assert.equal(r.traces.length, 0);
    assert.ok(r.budget.requests <= (limits.requests || 3000)); assert.ok(r.budget.traceRequests <= (limits.traceRequestCap || 512));
  }
  const seen = new Set(), limited = new Map();
  const f = fixture({ candidates: ["https://eth.alchemy.com/offline", "https://eth.infura.io/offline", "https://ethereum.publicnode.com/offline", "https://eth.drpc.org/offline", "https://rpc.ankr.com/eth"], hook(c) {
    const key = capture.canonical([c.index, c.method, c.params]);
    if (!seen.has(key) && (limited.get(c.index) || 0) < 4) {
      seen.add(key); limited.set(c.index, (limited.get(c.index) || 0) + 1);
      return { status: 429, raw: SENTINEL, headers: { "retry-after": "1" } };
    }
  } }), r = await run(f);
  assert.equal(r.reason, "retry-budget-exhausted"); assert.equal(r.status, "LIMIT-REACHED"); assert.equal(r.backoff.retries, 16);
});

test("selected-pair posttrace receipt/header rechecks and final C2 anchor conflict invalidate any saved prefix", async () => {
  for (const mode of ["receipt", "header", "anchor"]) {
    const f = fixture({ hook(c) {
      if (c.index === 1 && ((mode === "receipt" && c.u === 1 && c.method === "eth_getTransactionReceipt" && c.fixture.calls.some(v => v.u === 1 && isState(v)))
          || (mode === "header" && c.method === "eth_getBlockByHash" && c.params[0] === H(101) && c.fixture.calls.some(v => v.u === 1 && isState(v))))) {
        if (mode === "receipt") c.result.cumulativeGasUsed = "0x1"; else c.result.stateRoot = H(999);
      }
      if (mode === "anchor" && c.index === 1 && c.method === "eth_getBlockByNumber" && c.params[0] === Q(1000)) c.result.hash = H(999);
      return { result: c.result };
    } }), p = await published(f);
    try {
      assert.equal(p.result.status, "CAPTURE-FAILED"); assert.equal(p.result.aggregateEvidenceStatus, "INVALID"); assert.ok(p.result.traces.length >= 1);
      assert.throws(() => read(p.out, f, { allowPartial: true }), /invalid-schema/);
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});

test("concurrent integrity is latched ahead of availability; shutdown expiry cannot restore a valid aggregate", async () => {
  const f = fixture({ hook(c) {
    if (c.u === 1 && isCall(c)) return c.index === 0 ? { status: 503, raw: SENTINEL } : { result: { invalid: SENTINEL } };
  } }), original = capture.createRuntime;
  capture.createRuntime = options => { const runtime = original(options); return Object.freeze({ ...runtime, close: async () => { await runtime.close(); f.setNow(Date.parse(capture.EXPIRES_AT)); } }); };
  try {
    const r = await run(f); assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "invalid-trace"); assert.equal(r.lifecycleFailure, "session-expired");
    assert.equal(r.traces.length, 1); assert.equal(r.runtimeDrained, true); assert.equal(r.aggregateEvidenceStatus, "INVALID");
  } finally { capture.createRuntime = original; }
});

test("CLI rejects unknown/Base/input/budget flags and checks exclusive output, expiry and parent before loading", async () => {
  const root = temp(); let loads = 0;
  try {
    for (const extra of ["--chain=8453", "--input=other", "--requests=1", "--endpoint=secret", "--enrich"]) {
      assert.throws(() => cli.parseArgs(["--enrich", "--chain=1", "--out=x", extra]), /invalid-options/);
    }
    for (const mode of ["exists", "expiry", "hash"]) {
      const out = path.join(root, mode); if (mode === "exists") fs.mkdirSync(out);
      assert.equal(await cli.main(["--enrich", "--chain=1", `--out=${out}`], {
        now: () => mode === "expiry" ? Date.parse(capture.EXPIRES_AT) : START,
        loadParent() { assert.equal(mode, "hash"); throw new Error("invalid-schema"); },
        loadAuthorizedCandidates() { loads++; throw new Error(SENTINEL); }, print() {},
      }), 2);
    }
    assert.equal(loads, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI keeps Origin process-only and closes/drains then disposes before publication", async () => {
  const root = temp(), out = path.join(root, "cli"), f = fixture(), order = [], printed = [];
  try {
    const code = await cli.main(["--enrich", "--chain=1", `--out=${out}`], {
      now: f.now, print: text => printed.push(text),
      createTraceWriter(directory) { const writer = cli.createTraceWriter(directory); order.push("reserve"); return { ...writer, publish(...args) { assert.equal(order.at(-1), "dispose"); order.push("publish"); return writer.publish(...args); } }; },
      loadParent() { assert.ok(fs.existsSync(out)); order.push("parent"); return f.parent; },
      loadAuthorizedCandidates(options) { assert.deepEqual(options, { chainId: 1, cap: 16 }); order.push("load"); return { candidates: f.candidates, getOrigin: () => "https://owned-origin.invalid",
        dispose() { assert.equal(order.at(-1), "drain"); order.push("dispose"); }, toJSON() { throw new Error(SENTINEL); } }; },
      async runEnrichment(options) { const r = await t1.runEnrichment({ ...options, runtimeOptions: { ...f.options, ...options.runtimeOptions } }); assert.equal(r.runtimeDrained, true); order.push("drain"); return r; },
    });
    assert.equal(code, 0, printed.join("")); assert.deepEqual(order, ["reserve", "parent", "load", "drain", "dispose", "publish"]);
    assert.ok(f.origins.every(value => value === "https://owned-origin.invalid")); assert.equal(read(out, f).authority.validAggregate, true);
    assert.ok(!/owned-origin|RAW_PRIVATE|https:/.test(printed.join("")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("adapter disposal is mandatory on runtime throw/init failures and failure prohibits publication", async () => {
  for (const mode of ["throw", "init", "dispose", "load"]) {
    const f = fixture(), order = [], printed = [];
    const code = await cli.main(["--enrich", "--chain=1", "--out=synthetic"], {
      now: f.now, print: text => printed.push(text), loadParent: () => f.parent,
      createTraceWriter: () => ({ onTrace() {}, publish(result) { order.push("publish"); return { status: result.status }; } }),
      loadAuthorizedCandidates() { if (mode === "load") throw new Error(SENTINEL); return { candidates: f.candidates, getOrigin: () => null,
        dispose() { order.push("dispose"); if (mode === "dispose") throw new Error(SENTINEL); } }; },
      async runEnrichment(options) {
        if (mode === "throw") throw new Error(SENTINEL);
        const r = await t1.runEnrichment({ ...options, runtimeOptions: { ...f.options, ...options.runtimeOptions, ...(mode === "init" ? { backoffRandom: 1 } : {}) } });
        assert.equal(r.runtimeDrained, true); order.push("drain"); return r;
      },
    });
    assert.equal(code, 2); assert.ok(!printed.join("").includes(SENTINEL));
    assert.deepEqual(order, mode === "load" ? [] : mode === "throw" ? ["dispose"] : mode === "init" ? ["drain", "dispose", "publish"] : ["drain", "dispose"]);
  }
});

test("reader requires terminal authority, exact hashes and ordered prefix; partial is explicit and forged COMPLETE never passes", async () => {
  const f = fixture({ hook: c => c.u === 1 && isCall(c) && c.index === 0 ? { status: 503, raw: SENTINEL } : {} }), p = await published(f);
  try {
    assert.equal(p.result.status, "ACCESS-BLOCKED"); assert.equal(p.result.traces.length, 1);
    assert.throws(() => read(p.out, f), /invalid-schema/);
    assert.equal(read(p.out, f, { allowPartial: true, expectedManifestSha256: p.summary.manifestSha256 }).authority.aggregateEvidenceStatus, "PARTIAL");
    assert.throws(() => read(p.out, f, { allowPartial: true, expectedManifestSha256: "0".repeat(64) }), /invalid-schema/);
    const file = path.join(p.out, "terminalmanifest.json"), text = fs.readFileSync(file, "utf8"), base = JSON.parse(text);
    for (const mutate of [m => { m.status = "COMPLETE"; m.reason = null; m.aggregateEvidenceStatus = "VALIDATED"; m.finalAnchorRechecked = true; m.gapReason = null; },
      m => { m.traces[0].file = "../trace00001.json"; }, m => { m.traces[0].sha256 = "0".repeat(64); }, m => { m.traces[0].universeIndex = 1; },
      m => { m.missingIndices = []; }, m => { m.integrityFailure = { code: "consensus-mismatch" }; }, m => { m.universe.reverse(); }, m => { m.sourceC2ManifestSha256 = "0".repeat(64); },
      m => { m.limits.traceRequestCap = 513; }, m => { m.backoff.pendingRuns = 1; }, m => { m.transportDiagnostics[0].url = SENTINEL; }, m => { m.mode = "unknown"; }]) {
      const value = clone(base); mutate(value); delete value.manifestEvidenceSha256; value.manifestEvidenceSha256 = capture.sha256(capture.canonical(value));
      fs.writeFileSync(file, JSON.stringify(value)); assert.throws(() => read(p.out, f, { allowPartial: true }), /invalid-schema/);
    }
    fs.writeFileSync(file, text);
    fs.writeFileSync(path.join(p.out, "trace00111.json"), "{}"); assert.throws(() => read(p.out, f, { allowPartial: true }), /invalid-schema/);
    fs.unlinkSync(path.join(p.out, "trace00111.json")); fs.unlinkSync(file); assert.throws(() => read(p.out, f, { allowPartial: true }), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("reader revalidates trace bodies, parent identity, receipt binding and metadata coverage even after rehashing", async () => {
  const f = fixture({ metadata: true }), p = await published(f);
  try {
    const mf = path.join(p.out, "terminalmanifest.json"), rf = path.join(p.out, "trace00001.json"), manifest = JSON.parse(fs.readFileSync(mf, "utf8")), row = JSON.parse(fs.readFileSync(rf, "utf8"));
    for (const mutate of [r => { r.transaction.nonce = "99"; }, r => { r.header.stateRoot = H(999); }, r => { r.callFrames[0].logs.pop(); },
      r => { r.metadataCoverage.logIndex.unknown = 1; }, r => { r.callFrames[0].depth = 1; }, r => { r.stateAccounts[0].native.before = SENTINEL; },
      r => { r.stateAccounts[0].codeHash.before = [H(10)]; }, r => { r.callFrames[0].outputSha256 = [r.callFrames[0].outputSha256]; },
      r => { r.stateAccounts[0].nonce.after = r.stateAccounts[0].nonce.before; }, r => { r.stateAccounts[0].nonce.before = "99"; },
      r => { r.senderNonceSanity.extraIncrementsStatus = "reconciled"; },
      r => { r.profitKnown = true; }, r => { r.callFrames[0].input = SENTINEL; }]) {
      const m = clone(manifest), r = clone(row); mutate(r); delete r.evidenceSha256; r.evidenceSha256 = capture.sha256(capture.canonical(r));
      const text = JSON.stringify(r); fs.writeFileSync(rf, text); m.traces[0].sha256 = capture.sha256(text); m.traces[0].evidenceSha256 = r.evidenceSha256;
      delete m.manifestEvidenceSha256; m.manifestEvidenceSha256 = capture.sha256(capture.canonical(m)); fs.writeFileSync(mf, JSON.stringify(m));
      assert.throws(() => read(p.out, f), /invalid-schema/);
    }
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("expired publication is invalid even after an otherwise complete drained result", async () => {
  const f = fixture(), root = temp(), out = path.join(root, "expired");
  try {
    const writer = cli.createTraceWriter(out), r = await run(f, { onTrace: writer.onTrace });
    const summary = writer.publish(r, f.parent, () => Date.parse(capture.EXPIRES_AT));
    assert.equal(summary.status, "LIMIT-REACHED"); assert.equal(summary.reason, "session-expired"); assert.equal(summary.aggregateEvidenceStatus, "INVALID");
    assert.throws(() => read(out, f, { allowPartial: true }), /invalid-schema/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("accounting scope comes only from exact C2 source chunk emitters, sorted/deduplicated with fixed ABI references", () => {
  const f = accountingFixture(), source = clone(f.authoritative);
  source.chunks.push(clone(source.chunks[1]));
  source.chunks.push({ sourceId: "compound-v3", logs: [{ address: D }], transactions: [], receiptEvidence: [], headers: [] });
  const parent = t1.prepareParent(source, 3);
  assert.deepEqual(parent.accountingScope, { basis: "observed-c2-chunk-emitters", compoundSourceId: "compound-iii", morphoSourceId: "morpho-blue",
    compoundEmitters: [B], morphoEmitters: [C], abiReferences: accounting.ABI_REFERENCES });
  source.chunks[1].logs[0].address = SENTINEL;
  assert.throws(() => t1.prepareParent(source, 3), /invalid-schema/);
});

test("paired Compound recipient and Morpho market/returns survive capture without callback or arbitrary payload retention", async () => {
  const f = accountingFixture({ metadata: true }), p = await published(f);
  try {
    assert.equal(p.result.status, "COMPLETE", p.result.reason);
    const loaded = read(p.out, f, { expectedManifestSha256: p.summary.manifestSha256 }), row = loaded.traces[0];
    const [compound, morpho] = row.callAccounting;
    assert.deepEqual(compound.abiInterpretation.arguments, { asset: C, minAmount: "17", baseAmount: "19", recipient: E });
    assert.deepEqual(compound.abiInterpretation.returns, { status: "void", reason: null, result: null });
    assert.deepEqual(morpho.abiInterpretation.arguments.marketParams, { loanToken: A, collateralToken: B, oracle: D, irm: E, lltv: String(MARKET[4]) });
    assert.equal(morpho.abiInterpretation.arguments.marketId, keccak256(AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address", "uint256"], MARKET)));
    assert.equal(morpho.abiInterpretation.arguments.callbackDataBytes, Buffer.byteLength(SENTINEL));
    assert.deepEqual(morpho.abiInterpretation.returns.result, { seizedAssets: "31", repaidAssets: "37" });
    assert.equal(row.accountingCoverage.decoded, 2); assert.equal(row.accountingCoverage.resultKnown, 1); assert.equal(row.accountingCoverage.voidReturns, 1);
    assert.equal(loaded.manifest.accountingCoverage.decoded, 6); assert.equal(loaded.manifest.accountingCoverage.resultKnown, 3);
    assert.equal(row.accountingProvenance.codeAddress, "nominal-unverified"); assert.equal(row.accountingProvenance.actualCodeOrigin, null);
    assert.ok(row.callAccounting.every(value => !value.abiInterpretation.sourceRuntimeVerified && !value.abiInterpretation.balancesVerified));
    assert.equal(row.metadataCoverage.logIndex.reportedBoth, 2); assert.equal(row.metadataCoverage.codeHashSides.reportedBoth, 2);
    assert.equal(p.result.budget.traceRequests, 14, "no added RPCs or repeated qualification fixture");
    const text = JSON.stringify(loaded);
    for (const value of [SENTINEL, CALLBACK.slice(2), capture.sha256(Buffer.from(SENTINEL)), keccak256(CALLBACK)]) assert.ok(!text.includes(value));
    assert.ok(!/"input"|"output"|callbackDataHash|"raw"/.test(text));
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("derived accounting contradictions survive later candidate retirement independently of trace-core metadata comparison", async () => {
  const f = accountingFixture({ hook(c) { if (c.index === 0 && isState(c)) return { status: 403, raw: SENTINEL }; } });
  const module = { exports: {} }; let extractions = 0;
  // Inject only the pure helper's result to exercise the separate derived-facts
  // ledger with identical raw/frame hashes. No production dependency is edited.
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../strategy-study/trace-enrichment.js"), "utf8"), {
    module, __dirname: path.join(__dirname, "../strategy-study"), require(name) {
      if (name === "node:path") return path;
      if (name === "./capture") return capture;
      if (name === "./call-accounting") return { ...accounting, extractCallAccounting(...args) {
        const rows = clone(accounting.extractCallAccounting(...args));
        if (extractions++ === 0) rows[0].abiInterpretation.arguments.recipient = D;
        return rows;
      } };
      assert.fail("unexpected dependency");
    },
  });
  const result = await module.exports.runEnrichment({ parent: f.parent, runtimeOptions: f.options });
  assert.equal(result.reason, "consensus-mismatch"); assert.equal(result.status, "CAPTURE-FAILED"); assert.equal(result.traces.length, 0);
  assert.equal(result.observations[0].call, "passed"); assert.equal(result.observations[0].reason, "provider-http-failure");
  assert.equal(extractions, 2);
  const changed = accountingFixture({ hook(c) {
    if (c.index === 0 && isCall(c)) c.result.calls[0].output = LIQUIDATE.encodeFunctionResult("liquidate", [99, 37]);
    if (c.index === 0 && isState(c)) return { status: 403, raw: SENTINEL };
    return { result: c.result };
  } }), rejected = await run(changed);
  assert.equal(rejected.reason, "consensus-mismatch"); assert.equal(rejected.aggregateEvidenceStatus, "INVALID");
});

test("ABI unknown is explicit after COMPLETE and never masks raw/root binding failures", async () => {
  for (const mode of ["unsupported", "malformed", "oversized", "wrong-target", "no-selector", "bad-return"]) {
    const f = accountingFixture({ sources: mode === "wrong-target" ? [{ sourceId: "compound-iii", addresses: [B] }] : undefined,
      accountingTrace(raw) {
        const child = raw.calls[0];
        if (mode === "unsupported") child.input = "0xa9059cbb";
        if (mode === "malformed") child.input = morphoInput() + "00";
        if (mode === "oversized") child.input = morphoInput(`0x${"ab".repeat(accounting.CALL_ACCOUNTING_LIMITS.decodeBytes)}`);
        if (mode === "no-selector") child.input = "0x12";
        if (mode === "bad-return") child.output = "0x12";
        return raw;
      } }), p = await published(f);
    try {
      assert.equal(p.result.status, "COMPLETE", `${mode}: ${p.result.reason}`);
      const loaded = read(p.out, f), abi = loaded.traces[0].callAccounting[1].abiInterpretation;
      const reason = { unsupported: "unsupported-selector", malformed: "invalid-calldata", oversized: "decode-limit-exceeded", "wrong-target": "unqualified-target", "no-selector": "no-selector", "bad-return": "invalid-return-data" }[mode];
      if (mode === "bad-return") { assert.equal(abi.returns.reason, reason); assert.equal(loaded.manifest.accountingCoverage.returnUnknownReasons[reason], 3); }
      else { assert.equal(abi.reason, reason); assert.equal(loaded.manifest.accountingCoverage.unknownReasons[reason], 3); }
      assert.equal(loaded.manifest.accountingCoverage.resultKnown, 0);
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
  const bad = accountingFixture({ hook(c) { if (isCall(c)) c.result.input = "0x12345678"; return { result: c.result }; } }), r = await run(bad);
  assert.equal(r.reason, "trace-receipt-mismatch"); assert.equal(r.aggregateEvidenceStatus, "INVALID");
});

test("scope admission uses delegated execution context, while every code target remains nominal/unverified", async () => {
  const f = accountingFixture({ accountingTrace(raw) {
    const frame = (type, from, to, input, calls = []) => ({ type, from, to, input, calls, value: "0x0", gas: "0x100", gasUsed: "0x10", output: "0x" });
    raw.calls.push(frame("DELEGATECALL", B, D, buyInput()), frame("CALL", B, E, "0x", [frame("DELEGATECALL", E, B, buyInput())]));
    return raw;
  } }), p = await published(f);
  try {
    assert.equal(p.result.status, "COMPLETE", p.result.reason);
    const row = read(p.out, f).traces[0];
    assert.equal(row.callAccounting[2].executionAddress, B); assert.equal(row.callAccounting[2].codeAddress, D);
    assert.equal(row.callAccounting[2].abiInterpretation.status, "decoded");
    assert.equal(row.callAccounting[4].executionAddress, E); assert.equal(row.callAccounting[4].codeAddress, B);
    assert.equal(row.callAccounting[4].abiInterpretation.reason, "unqualified-target");
    assert.equal(row.callFrames[4].parent, 3); assert.equal(row.callAccounting[4].frameIndex, 4);
    assert.equal(row.accountingProvenance.codeAddress, "nominal-unverified"); assert.equal(row.accountingProvenance.actualCodeOrigin, null);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("reverted and ancestor-reverted decoded inputs never acquire committed return quantities", async () => {
  const f = accountingFixture({ accountingTrace(raw) {
    const child = { ...raw.calls[0], logs: [], error: SENTINEL };
    raw.calls.push({ ...child, calls: [{ ...raw.calls[0], logs: [] }] }); return raw;
  } }), p = await published(f);
  try {
    assert.equal(p.result.status, "COMPLETE", p.result.reason); const row = read(p.out, f).traces[0];
    assert.equal(row.callAccounting[2].abiInterpretation.returns.reason, "reverted");
    assert.equal(row.callAccounting[3].abiInterpretation.returns.reason, "ancestor-reverted");
    assert.equal(row.accountingCoverage.reverted, 2); assert.equal(row.accountingCoverage.resultKnown, 1);
    assert.equal(row.callAccounting[3].abiInterpretation.returns.result, null);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("reader rejects corrupted accounting schema, context, scope, canonical fields and coverage after rehashing", async () => {
  const f = accountingFixture(), p = await published(f);
  try {
    const mf = path.join(p.out, "terminalmanifest.json"), rf = path.join(p.out, "trace00001.json");
    const manifest = JSON.parse(fs.readFileSync(mf, "utf8")), row = JSON.parse(fs.readFileSync(rf, "utf8"));
    for (const mutate of [r => { r.callAccounting.pop(); }, r => { r.callAccounting[0].frameIndex = 1; },
      r => { r.callAccounting[0].selector = "0x123"; }, r => { r.callAccounting[0].inputBytes = 131; }, r => { r.callAccounting[0].outputBytes = -1; },
      r => { r.callAccounting[0].executionAddress = C; }, r => { r.callAccounting[1].codeAddress = E; },
      r => { r.callAccounting[1].abiInterpretation.arguments.marketId = H(999); }, r => { r.callAccounting[1].abiInterpretation.arguments.marketParams.oracle = A; },
      r => { r.callAccounting[1].abiInterpretation.arguments.callbackDataBytes = 123; }, r => { r.callAccounting[0].abiInterpretation.arguments.recipient = E.toUpperCase(); },
      r => { r.callAccounting[0].abiInterpretation.arguments.baseAmount = String(1n << 256n); }, r => { r.callAccounting[1].abiInterpretation.returns.result.repaidAssets = "01"; },
      r => { r.callAccounting[0].abiInterpretation.returns = { status: "decoded", reason: null, result: { amount: "19" } }; },
      r => { r.callAccounting[1].abiInterpretation.sourceRuntimeVerified = true; }, r => { r.callAccounting[1].abiInterpretation.arguments.callbackData = CALLBACK; },
      r => { r.callAccounting[0].raw = SENTINEL; }, r => { r.accountingCoverage.unknownReasons.fabricated = 0; },
      r => { r.accountingCoverage.resultKnown++; }, r => { r.accountingProvenance.codeAddress = "verified"; }, r => { r.accountingProvenance.actualCodeOrigin = E; }]) {
      const r = clone(row), m = clone(manifest); mutate(r); delete r.evidenceSha256; r.evidenceSha256 = capture.sha256(capture.canonical(r));
      const text = JSON.stringify(r); fs.writeFileSync(rf, text); m.traces[0].sha256 = capture.sha256(text); m.traces[0].evidenceSha256 = r.evidenceSha256;
      delete m.manifestEvidenceSha256; m.manifestEvidenceSha256 = capture.sha256(capture.canonical(m)); fs.writeFileSync(mf, JSON.stringify(m));
      assert.throws(() => read(p.out, f), /invalid-schema/);
    }
    const text = JSON.stringify(row); fs.writeFileSync(rf, text);
    for (const mutate of [m => { m.accountingScope.compoundEmitters.push(D); }, m => { m.accountingScope.abiReferences.compound.signature = "arbitrary()"; },
      m => { m.accountingCoverage.decoded++; }, m => { m.accountingProvenance.actualCodeOrigin = B; }]) {
      const m = clone(manifest); m.traces[0].sha256 = capture.sha256(text); mutate(m);
      delete m.manifestEvidenceSha256; m.manifestEvidenceSha256 = capture.sha256(capture.canonical(m)); fs.writeFileSync(mf, JSON.stringify(m));
      assert.throws(() => read(p.out, f), /invalid-schema/);
    }
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("reader rejects symlink trace files", async t => {
  const f = fixture(), p = await published(f);
  try {
    const file = path.join(p.out, "trace00001.json"), target = path.join(p.root, "copy.json"); fs.renameSync(file, target);
    try { fs.symlinkSync(target, file, "file"); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Windows symlink permission unavailable"); throw error; }
    assert.throws(() => read(p.out, f), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
}
