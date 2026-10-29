"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Interface } = require("ethers");
const capture = require("../strategy-study/capture");
const { buildRegistry } = require("../strategy-study/registry");
const { runCensus, CAPS, CUTOFF, C2_LIMITS, C2_PHASES } = require("../strategy-study/census");
const cli = require("../strategy-study/census-cli");

const T = BigInt(Date.parse(CUTOFF) / 1000), START_MS = Date.parse("2026-10-20T02:00:00Z");
const H = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`, Q = n => `0x${BigInt(n).toString(16)}`;
const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333", D = "0x4444444444444444444444444444444444444444";
const SENTINEL = "SECRET_TOKEN_MUST_NOT_ESCAPE", OFFSET = 1n << 80n;
const clone = value => structuredClone(value);
function registry(chainId = 1, ids = ["aave-v3"]) {
  const all = buildRegistry({ chainId, readFile() { const e = new Error("missing fixture"); e.code = "ENOENT"; throw e; } });
  return { chainId, sources: all.sources.filter(s => ids.includes(s.id)).map(s => s.id === "aave-v4" && !s.addresses.length ? { ...s, addresses: [A] } : s), coverageNotes: ["TEST_SEED_ONLY"] };
}
function fixture(options = {}) {
  const chainId = options.chainId || 1, reg = options.registry || registry(chainId, options.sources);
  const step = chainId === 1 ? 12 : 2;
  const cutoff = capture.FIXTURES[chainId].number + 1000, first = cutoff - 604800 / step, finalized = cutoff + 100;
  const prefix = chainId === 1 ? "eth-mainnet" : "base-mainnet";
  const candidates = options.candidates || [`https://${prefix}.g.alchemy.com/offline`, `https://${prefix}.infura.io/offline`, `https://${prefix}.publicnode.com/offline`];
  const calls = [], txHash = (n, index = 0) => H(OFFSET + BigInt(n) * 16n + BigInt(index));
  const location = hash => { const n = BigInt(hash) - OFFSET; return { number: Number(n / 16n), index: Number(n % 16n) }; };
  const plans = options.events === undefined ? [{ number: first + 10 }] : options.events.map(p => ({ ...p, number: p.number ?? (p.offset === undefined ? first + 10 : cutoff + p.offset) }));
  const source = id => reg.sources.find(s => s.id === (id || "aave-v3"));
  function log(plan) {
    const s = source(plan.sourceId), index = plan.txIndex || 0;
    const defaults = s.id === "aave-v4" ? [1, 2, C, D, true, 10, 11, [-1, -2, 3], 20, 21, 19] : [A, B, C, 10, 20, D, false];
    const encoded = new Interface(s.abi).encodeEventLog(plan.eventName || "LiquidationCall", plan.values || defaults);
    return { address: plan.address || s.addresses[0], ...encoded, blockNumber: Q(plan.number), blockHash: H(plan.number + 1),
      transactionHash: txHash(plan.number, index), transactionIndex: Q(index), logIndex: Q(plan.logIndex || 0), removed: false };
  }
  const logs = plans.map(log);
  function block(n) { return { number: Q(n), hash: H(n + 1), parentHash: H(n), stateRoot: H((1n << 90n) + BigInt(n)),
    timestamp: Q(T + BigInt(n - cutoff) * BigInt(step)), transactions: Array.from({ length: options.depositFirst ? 2 : 1 }, (_, i) => txHash(n, i)), ignored: SENTINEL }; }
  function tx(hash) {
    const { number, index } = location(hash);
    return { hash, blockHash: H(number + 1), blockNumber: Q(number), transactionIndex: Q(index), from: A, to: B, type: options.depositFirst && index === 0 ? "0x7e" : "0x2",
      nonce: "0x1", gas: "0x5208", value: "0x0", input: "0x", chainId: Q(chainId), ignored: SENTINEL };
  }
  function receipt(hash) {
    const t = tx(hash);
    return { transactionHash: hash, blockHash: t.blockHash, blockNumber: t.blockNumber, transactionIndex: t.transactionIndex, from: A, to: B, type: t.type,
      status: "0x1", gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x2", contractAddress: null,
      logs: logs.filter(row => row.transactionHash === hash), ignored: SENTINEL };
  }
  let clock = START_MS;
  async function transport(request) {
    const index = candidates.indexOf(request.provider.url), call = { index, method: request.method, params: clone(request.params) };
    calls.push(call);
    let result;
    switch (request.method) {
      case "eth_chainId": result = Q(chainId); break;
      case "eth_getBlockByNumber": result = block(request.params[0] === "finalized" ? finalized : Number(BigInt(request.params[0]))); break;
      case "eth_getBlockByHash": result = block(Number(BigInt(request.params[0])) - 1); break;
      case "eth_getTransactionByHash": result = tx(request.params[0]); break;
      case "eth_getTransactionReceipt": result = receipt(request.params[0]); break;
      case "eth_getLogs": {
        const scope = request.params[0];
        result = logs.filter(row => BigInt(row.blockNumber) >= BigInt(scope.fromBlock) && BigInt(row.blockNumber) <= BigInt(scope.toBlock)
          && scope.address.includes(row.address) && scope.topics[0].includes(row.topics[0]));
        break;
      }
      case "debug_traceTransaction": throw new Error("provider-method-not-found");
      default: assert.fail("unexpected method");
    }
    if (options.hook) result = await options.hook({ ...call, result: clone(result), block, tx, receipt, first, cutoff, finalized, logs, txHash,
      setNow(value) { clock = value; } });
    return { result };
  }
  return { chainId, registry: reg, calls, logs, first, cutoff, finalized, block, tx, receipt, txHash, setNow: value => { clock = value; },
    options: { candidates, shared: { loadRpcUrls() { throw new Error("INVENTORY_FORBIDDEN"); }, getOrigin() { return "https://offline.invalid"; } },
      transport, now: () => clock, sleep: async ms => { clock += ms; }, ...(options.limits ? { limits: options.limits } : {}) } };
}
async function run(f, extras = {}) { return runCensus({ chainId: f.chainId, registry: f.registry, runtimeOptions: f.options, ...extras }); }
function multiBlock(call) { return call.method === "eth_getLogs" && call.params[0].fromBlock !== call.params[0].toBlock; }
function aggregate(result) {
  const parent = temporary(), out = path.join(parent, "aggregate");
  try {
    const writer = cli.createCensusWriter(out);
    result.chunks.forEach(chunk => writer.onChunk(chunk));
    writer.publish(result, cli.REGISTRY_SHA256, () => Date.parse(result.endedAt) + 1);
    return cli.readAuthoritativeCensus(out).scorecard.scorecard;
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}
function temporary() {
  const approved = path.join(os.tmpdir(), "opencode");
  fs.mkdirSync(approved, { recursive: true });
  return fs.mkdtempSync(path.join(approved, "census-test-"));
}

test("C1 succeeds without either tracer, uses the full basic pool then fixed independent pair, and drains", async () => {
  const f = fixture(), r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason);
  assert.equal(r.runtimeDrained, true);
  assert.equal(r.finalAnchorRechecked, true);
  assert.deepEqual(r.selectedAliases, ["obs-01", "obs-02"]);
  assert.equal(r.budget.traceRequests, 0);
  assert.equal(f.calls.some(c => c.method.startsWith("debug_") || c.method === "eth_call"), false);
  const firstTx = f.calls.findIndex(c => c.method === "eth_getTransactionByHash");
  for (const index of [0, 1, 2]) assert.ok(f.calls.findIndex(c => c.index === index && c.method === "eth_getLogs") < firstTx);
  const firstRange = f.calls.findIndex(multiBlock);
  for (const index of [0, 1, 2]) assert.ok(f.calls.findIndex(c => c.index === index && c.method === "eth_getTransactionReceipt") < firstRange);
  assert.equal(f.calls.slice(firstRange).some(c => c.index === 2), false);
  assert.equal(r.methodCapabilities.traces, "unknown");
  assert.equal(r.methodCapabilities.state, "unknown");
  assert.equal(r.finality.cryptographicAncestryProof, false);
  assert.ok(!/alchemy|infura|publicnode|https:|SECRET_TOKEN/.test(JSON.stringify(r)));
  assert.equal(r.counts.events, 1);
  assert.equal(r.chunks.flatMap(c => c.logs).length, 1);
  assert.equal(aggregate(r).fees.knownFeeWeiSum, "42000");
});

test("preselection request-timeout retires only that candidate and continues full pool without retries", async () => {
  const f = fixture({ hook(c) { if (c.index === 0 && c.method === "eth_getTransactionReceipt") throw new Error("request-timeout"); return c.result; } });
  const r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason);
  assert.deepEqual(r.selectedAliases, ["obs-02", "obs-03"]);
  assert.equal(r.observations[0].reason, "request-timeout");
  assert.equal(r.observations[0].transaction, "passed");
  assert.equal(r.observations[0].receipt, "failed");
  assert.equal(f.calls.filter(c => c.index === 0 && c.method === "eth_getTransactionReceipt").length, 1);
  assert.equal(r.budget.requests, f.calls.length);
});

test("wrong-chain candidate receives no target read; null and expected capability failures retire safely", async () => {
  for (const mode of ["wrong", "null", "method", "http", "rpc"]) {
    const f = fixture({ hook(c) {
      if (c.index === 0 && c.method === "eth_chainId") {
        if (mode === "wrong") return "0xa";
        if (mode === "null") return null;
        throw new Error({ method: "provider-method-not-found", http: "provider-http-failure", rpc: "provider-rpc-failure" }[mode]);
      }
      return c.result;
    } });
    const r = await run(f);
    assert.equal(r.status, "COMPLETE", `${mode}:${r.reason}`);
    assert.deepEqual(f.calls.filter(c => c.index === 0).map(c => c.method), ["eth_chainId"]);
  }
});

test("normalized partial header contradiction survives a later candidate-local timeout", async () => {
  const f = fixture({ hook(c) {
    if (c.index === 0 && c.method === "eth_getBlockByNumber" && c.params[0] === Q(capture.FIXTURES[1].number)) c.result.stateRoot = H(999);
    if (c.index === 0 && c.method === "eth_getBlockByHash" && c.params[0] === H(capture.FIXTURES[1].number + 1)) throw new Error("request-timeout");
    return c.result;
  } });
  const r = await run(f);
  assert.equal(r.reason, "consensus-mismatch");
  assert.equal(r.integrityFailure, true);
  assert.equal(r.chunks.length, 0);
  assert.equal(r.observations[0].reason, "request-timeout");
});

test("normalized transaction contradiction survives a later receipt timeout", async () => {
  const f = fixture({ hook(c) {
    if (c.index === 0 && c.method === "eth_getTransactionByHash") c.result.nonce = "0x2";
    if (c.index === 0 && c.method === "eth_getTransactionReceipt") throw new Error("request-timeout");
    return c.result;
  } });
  const r = await run(f);
  assert.equal(r.reason, "consensus-mismatch");
  assert.equal(r.chunks.length, 0);
  assert.equal(r.observations[0].transaction, "passed");
  assert.equal(r.observations[0].receipt, "failed");
});

test("same-height finalized disagreement and malformed responses are fatal, not rejected candidates", async () => {
  for (const mode of ["header", "shape", "logs", "chain"]) {
    const f = fixture({ hook(c) {
      if (c.index === 1 && c.method === "eth_getBlockByNumber" && c.params[0] === "finalized") {
        if (mode === "header") c.result.hash = H(123);
        if (mode === "shape") delete c.result.stateRoot;
      }
      if (c.index === 1 && mode === "logs" && c.method === "eth_getLogs") return {};
      if (c.index === 1 && mode === "chain" && c.method === "eth_chainId") return "not-chain-json";
      return c.result;
    } });
    const r = await run(f);
    assert.equal(r.status, "CAPTURE-FAILED", mode);
    assert.equal(r.chunks.length, 0);
    assert.equal(r.scorecardAllowed, false);
  }
});

test("Base deposit is skipped only within first eight corroborated fixture transaction hashes", async () => {
  const f = fixture({ chainId: 8453, depositFirst: true, events: [{ txIndex: 1 }] });
  const r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason);
  assert.equal(r.fixture.sampleTransactionHash, f.txHash(capture.FIXTURES[8453].number, 1));
  const rows = r.chunks.flatMap(c => c.receipts);
  assert.equal(rows[0].feeCompleteness, "unknown");
  assert.equal("totalFeeWei" in rows[0], false);
  assert.equal(aggregate(r).fees.knownFeeWeiSum, null);
});

test("only T and T-7 resolve; exact half-open boundaries and adjacent parent bindings", async () => {
  const f = fixture({ events: [{ offset: -50400 }, { offset: -1 }, { offset: 0 }, { offset: -50401 }] });
  const r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason);
  assert.deepEqual(r.boundaries.map(b => b.days), [0, 7]);
  assert.equal(r.window.fromBlock, String(f.first));
  assert.equal(r.window.toBlock, String(f.cutoff - 1));
  for (const b of r.boundaries) {
    assert.ok(BigInt(b.previous.timestamp) < BigInt(b.targetTimestamp));
    assert.ok(BigInt(b.first.timestamp) >= BigInt(b.targetTimestamp));
    assert.equal(b.first.parentHash, b.previous.hash);
    assert.ok(b.iterations <= 32);
  }
  assert.equal(r.counts.events, 2);
  assert.deepEqual(r.chunks.flatMap(c => c.events).map(e => e.timestamp), [String(T - 604800n), String(T - 12n)]);
});

test("unfinalized cutoff is fatal without moving the requested time", async () => {
  const f = fixture({ hook(c) {
    if (c.method === "eth_getBlockByNumber" && c.params[0] === "finalized") return c.block(c.cutoff - 1);
    return c.result;
  } });
  const r = await run(f);
  assert.equal(r.reason, "timestamp-boundary-unavailable");
  assert.equal(r.cutoffUtc, CUTOFF);
  assert.equal(r.chunks.length, 0);
});

test("zero-event ranges still require both providers and complete all fixed chronological bands", async () => {
  const f = fixture({ events: [] }), r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason);
  assert.equal(r.chunks.length, Math.ceil(50400 / 4096));
  assert.equal(r.counts.events, 0);
  assert.ok(r.chunks.every(c => c.events.length === 0));
  assert.equal(f.calls.filter(multiBlock).length, r.chunks.length * 2);
  assert.equal(r.coverage.filter(c => c.status === "missing").length, 0);
  assert.equal(r.protocolWideComplete, false);
});

test("postselection timeout is terminal and never substitutes the third candidate", async () => {
  const f = fixture({ hook(c) { if (c.index === 0 && multiBlock(c)) throw new Error("request-timeout"); return c.result; } });
  const r = await run(f);
  assert.equal(r.status, "LIMIT-REACHED");
  assert.equal(r.reason, "request-timeout");
  assert.equal(r.chunks.length, 0);
  const start = f.calls.findIndex(multiBlock);
  assert.equal(f.calls.slice(start).some(c => c.index === 2), false);
  assert.equal(r.coverage.length, 1);
  assert.equal(r.coverage[0].status, "missing");
});

test("only recognized log range restriction subdivides deterministically; all emitter batches restart at child ranges", async () => {
  const f = fixture({ events: [], hook(c) {
    if (c.index === 0 && multiBlock(c) && BigInt(c.params[0].toBlock) - BigInt(c.params[0].fromBlock) + 1n > 2048n) throw new Error("provider-log-range-restricted");
    return c.result;
  } });
  const r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason);
  assert.ok(r.chunks.every(c => BigInt(c.toBlock) - BigInt(c.fromBlock) + 1n <= 2048n));
  assert.equal(r.coverage[0].fromBlock, String(f.first));
  assert.equal(r.coverage[0].toBlock, String(f.cutoff - 1));
  assert.equal(r.attemptedLogWindows * 2 + 3, r.budget.logRequests);
  assert.ok(r.attemptedLogWindows <= CAPS.logWindows);
});

test("completed prefix survives later timeout with exact missing suffix", async () => {
  const f = fixture({ hook(c) { if (c.index === 0 && multiBlock(c) && BigInt(c.params[0].fromBlock) > BigInt(c.first)) throw new Error("request-timeout"); return c.result; } });
  const committed = [], r = await run(f, { onChunk(c) { committed.push(c); } });
  assert.equal(r.status, "LIMIT-REACHED");
  assert.equal(committed.length, 1);
  assert.equal(r.counts.events, 1);
  assert.deepEqual(r.coverage.map(c => [c.status, c.fromBlock, c.toBlock]), [
    ["validated", String(f.first), String(f.first + 4095)], ["missing", String(f.first + 4096), String(f.cutoff - 1)],
  ]);
  assert.equal(r.scorecardAllowed, true);
  assert.equal(r.finalAnchorRechecked, false);
});

test("partial 64-address batching never validates a logical source interval", async () => {
  const reg = registry();
  reg.sources[0].addresses = Array.from({ length: 65 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
  const f = fixture({ registry: reg, events: [], hook(c) { if (c.index === 0 && multiBlock(c) && c.params[0].address.length === 1) throw new Error("request-timeout"); return c.result; } });
  const r = await run(f);
  assert.equal(r.status, "LIMIT-REACHED");
  assert.equal(r.chunks.length, 0);
  assert.equal(r.coverage.length, 1);
  assert.equal(r.coverage[0].status, "missing");
  assert.equal(r.coverage[0].addressCount, 65);
  assert.deepEqual(f.calls.filter(c => c.index === 0 && multiBlock(c)).map(c => c.params[0].address.length), [64, 1]);
});

test("receipt/header/transaction/log material mismatches reject the entire affected chunk", async () => {
  for (const mode of ["receipt-log", "header", "tx", "log", "failed"]) {
    const f = fixture({ hook(c) {
      const eventHash = c.txHash(c.first + 10);
      if (mode === "receipt-log" && c.method === "eth_getTransactionReceipt" && c.params[0] === eventHash) c.result.logs[0].data = H(123);
      if (mode === "failed" && c.method === "eth_getTransactionReceipt" && c.params[0] === eventHash) c.result.status = "0x0";
      if (mode === "header" && c.index === 1 && c.method === "eth_getBlockByHash" && c.params[0] === H(c.first + 11)) c.result.stateRoot = H(123);
      if (mode === "tx" && c.index === 1 && c.method === "eth_getTransactionByHash" && c.params[0] === eventHash) c.result.nonce = "0x7";
      if (mode === "log" && c.index === 1 && multiBlock(c) && c.result.length) c.result[0].data = H(123);
      return c.result;
    } });
    const committed = [], r = await run(f, { onChunk(c) { committed.push(c); } });
    assert.equal(r.status, "CAPTURE-FAILED", `${mode}:${r.reason}`);
    assert.equal(committed.length, 0, mode);
    assert.equal(r.scorecardAllowed, false);
  }
});

test("cross-protocol events share one receipt/gas charge and retained typed proof has no generic raw fields", async () => {
  const f = fixture({ sources: ["aave-v3", "aave-v4"], events: [{ sourceId: "aave-v3", logIndex: 0 }, { sourceId: "aave-v4", logIndex: 1 }] });
  const r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason);
  assert.equal(r.counts.events, 2);
  assert.equal(r.counts.uniqueTransactions, 1);
  const eventHash = f.txHash(f.first + 10);
  assert.equal(f.calls.filter(c => c.method === "eth_getTransactionReceipt" && c.params[0] === eventHash).length, 2);
  assert.equal(r.chunks.flatMap(c => c.receiptEvidence).length, 1);
  assert.equal(r.chunks.flatMap(c => c.transactions).length, 1);
  const s = aggregate(r);
  assert.equal(s.summary.uniqueCensusTransactions, 1);
  assert.equal(s.fees.knownFeeWeiSum, "42000");
  assert.equal(s.economics.realizedProfitNative, null);
  assert.ok(!JSON.stringify(r).includes(SENTINEL));
});

test("identical canonical log duplicates collapse, conflicting duplicates are fatal", async () => {
  for (const conflict of [false, true]) {
    const f = fixture({ hook(c) {
      if (c.method === "eth_getLogs" && c.result.length) c.result.push({ ...c.result[0], ...(conflict ? { data: H(123) } : {}) });
      return c.result;
    } });
    const r = await run(f);
    assert.equal(r.status, conflict ? "CAPTURE-FAILED" : "COMPLETE", r.reason);
    assert.equal(r.counts.events, conflict ? 0 : 1);
    if (!conflict) assert.equal(aggregate(r).fees.knownFeeWeiSum, "42000");
  }
});

test("range RPC rejection at the minimum one-block size remains an explicit access gap", async () => {
  const f = fixture({ events: [], hook(c) {
    if (c.method === "eth_getLogs" && c.params[0].fromBlock !== Q(capture.FIXTURES[1].number)) throw new Error("provider-log-range-restricted");
    return c.result;
  } });
  const r = await run(f);
  assert.equal(r.status, "ACCESS-BLOCKED");
  assert.equal(r.reason, "provider-log-range-restricted");
  assert.equal(r.chunks.length, 0);
  assert.equal(r.coverage[0].status, "missing");
  assert.equal(r.scorecardAllowed, true);
});

test("ABI-unresolved events remain in census with normalized raw log evidence", async () => {
  const f = fixture({ hook(c) {
    if (c.method === "eth_getLogs" && multiBlock(c)) c.result.forEach(log => { log.data = "0x12"; });
    if (c.method === "eth_getTransactionReceipt") c.result.logs.forEach(log => { log.data = "0x12"; });
    return c.result;
  } });
  const r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason);
  assert.equal(r.chunks.flatMap(c => c.events)[0].decoded.status, "unresolved");
  assert.equal(r.chunks.flatMap(c => c.logs)[0].data, "0x12");
  assert.equal(aggregate(r).summary.unresolvedInWindowEvents, 1);
});

test("empty emitters are explicit gaps and factory discovery never enters liquidation ranges", async () => {
  const reg = registry(1, ["aave-v3", "euler-evk-factory", "euler-evk", "silo-v3-defaulting-accounting"]);
  const f = fixture({ registry: reg, events: [] }), r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason);
  assert.deepEqual(r.sourceGaps.map(g => g.reason).sort(), ["deployment-discovery-excluded", "empty-emitter-seed", "empty-emitter-seed"]);
  assert.ok(r.chunks.every(c => c.sourceId === "aave-v3"));
  assert.equal(r.coverage.filter(c => c.status === "missing").length, 2);
  assert.equal(r.coverage.some(c => c.sourceId === "euler-evk-factory"), false);
});

test("global request/log/time limits and absolute expiry never become candidate-local timeouts", async () => {
  for (const [limits, expected] of [[{ requests: 5 }, "request-budget-exhausted"], [{ logRequests: 1 }, "log-request-budget-exhausted"], [{ totalTimeoutMs: 100 }, "total-time-budget-exhausted"]]) {
    const f = fixture({ limits }), r = await run(f);
    assert.equal(r.reason, expected);
    assert.equal(r.status, "LIMIT-REACHED");
    assert.equal(r.chunks.length, 0);
    assert.ok(r.budget.requests <= (limits.requests || 6000));
  }
  const f = fixture({ hook(c) { if (c.method === "eth_chainId") c.setNow(Date.parse(capture.EXPIRES_AT)); return c.result; } });
  const r = await run(f);
  assert.equal(r.reason, "session-expired");
  assert.equal(r.scorecardAllowed, false);
  assert.equal(r.runtimeDrained, true);
});

test("unique-transaction hard cap stops the entire source chunk, not a top-N selection", async () => {
  const f = fixture({ hook(c) {
    if (multiBlock(c) && c.result.length) {
      const original = c.result[0];
      return Array.from({ length: 5001 }, (_, i) => ({ ...original, transactionHash: H(OFFSET + BigInt(c.first + 10) * 16n + BigInt(i)), transactionIndex: Q(i), logIndex: Q(i) }));
    }
    return c.result;
  } });
  const r = await run(f);
  assert.equal(CAPS.events, 50000);
  assert.equal(CAPS.transactions, 5000);
  assert.equal(r.status, "LIMIT-REACHED");
  assert.equal(r.reason, "chunk-budget-exhausted");
  assert.equal(r.counts.events, 0);
  assert.equal(r.chunks.length, 0);
  assert.equal(r.coverage[0].status, "missing");
});

test("Ethereum blob fees use exact products; absent applicable component remains unknown; Base always unknown", async () => {
  for (const [chainId, missing] of [[1, false], [1, true], [8453, false]]) {
    const f = fixture({ chainId, hook(c) {
      if (c.method === "eth_getTransactionByHash") { c.result.type = "0x3"; c.result.blobVersionedHashes = [H(123)]; }
      if (c.method === "eth_getTransactionReceipt") {
        c.result.type = "0x3"; c.result.blobGasUsed = "0x20000";
        if (!missing) c.result.blobGasPrice = Q(9007199254740993n);
        c.result.l1Fee = "0x10";
      }
      return c.result;
    } });
    const r = await run(f), row = r.chunks.flatMap(c => c.receipts)[0];
    assert.equal(r.status, "COMPLETE", r.reason);
    assert.equal(row.feeCompleteness, chainId === 1 && !missing ? "complete" : "unknown");
    if (chainId === 1 && !missing) assert.equal(row.totalFeeWei, (42000n + 131072n * 9007199254740993n).toString());
    else assert.equal("totalFeeWei" in row, false);
    assert.equal(row.costComplete, false);
    assert.equal(r.chunks.flatMap(c => c.receiptEvidence)[0].l1Fee, "16");
  }
});

test("missing effective price keeps receipt evidence but supplies no invented scorecard gas price", async () => {
  const f = fixture({ hook(c) { if (c.method === "eth_getTransactionReceipt") delete c.result.effectiveGasPrice; return c.result; } });
  const r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason);
  assert.equal(r.chunks.flatMap(c => c.receiptEvidence).length, 1);
  assert.equal(r.chunks.flatMap(c => c.receipts).length, 0);
  assert.equal(r.chunks.flatMap(c => c.receiptGaps).length, 1);
  assert.equal(aggregate(r).fees.knownFeeWeiSum, null);
});

test("final anchor contradiction supersedes previously committed chunk quality", async () => {
  let anchors = 0;
  const f = fixture({ hook(c) {
    if (c.index === 0 && c.method === "eth_getBlockByNumber" && c.params[0] === Q(c.finalized) && ++anchors === 2) c.result.stateRoot = H(123);
    return c.result;
  } });
  const r = await run(f);
  assert.equal(r.status, "CAPTURE-FAILED");
  assert.equal(r.reason, "consensus-mismatch");
  assert.ok(r.chunks.length > 0);
  assert.equal(r.failurePhase, "final-anchor-recheck");
  assert.equal(r.scorecardAllowed, false);
});

test("onChunk failure is sanitized and uncommitted chunks are not coverage", async () => {
  const f = fixture(), r = await run(f, { onChunk() { throw new Error(SENTINEL); } });
  assert.equal(r.reason, "chunk-commit-failed");
  assert.equal(r.chunks.length, 0);
  assert.equal(r.coverage[0].status, "missing");
  assert.equal(r.runtimeDrained, true);
  assert.ok(!JSON.stringify(r).includes(SENTINEL));
});

test("CLI reserves exclusive output before loading registry/runtime and writes only fixed new files", async () => {
  const parent = temporary(), out = path.join(parent, "capture"), f = fixture(), printed = [];
  let called = false;
  try {
    const code = await cli.main(["--census", "--chain=1", `--out=${out}`], {
      loadRegistryArtifact() { assert.ok(fs.existsSync(out)); return { registry: f.registry, registryArtifactSha256: cli.REGISTRY_SHA256 }; },
      runCensus(options) { called = true; return runCensus({ ...options, runtimeOptions: f.options }); }, now: () => START_MS, print: value => printed.push(value),
    });
    assert.equal(code, 0);
    assert.equal(called, true);
    assert.ok(fs.existsSync(path.join(out, "terminalmanifest.json")));
    assert.ok(fs.existsSync(path.join(out, "scorecard.json")));
    assert.ok(fs.existsSync(path.join(out, "scorecard.md")));
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "terminalmanifest.json"), "utf8"));
    assert.equal(manifest.registryArtifactSha256, cli.REGISTRY_SHA256);
    assert.equal(manifest.runtimeDrained, true);
    assert.ok(manifest.chunks.every(c => fs.existsSync(path.join(out, c.file))));
    called = false;
    const again = await cli.main(["--census", "--chain=1", `--out=${out}`], { loadRegistryArtifact() { called = true; throw new Error(SENTINEL); }, print: value => printed.push(value) });
    assert.equal(again, 2);
    assert.equal(called, false);
    assert.ok(printed.every(s => !/SECRET_TOKEN|https:|alchemy|infura|publicnode/.test(s)));
    assert.deepEqual(Object.keys(JSON.parse(printed[0])).sort(), ["captureId", "chainId", "eventCount", "missingIntervals", "reason", "status", "transactionCount", "validatedIntervals"].sort());
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("CLI does not publish a valid scorecard for global integrity failure or after expiry", async () => {
  const parent = temporary();
  try {
    for (const expired of [false, true]) {
      let anchors = 0;
      const f = fixture({ hook(c) { if (!expired && c.index === 0 && c.method === "eth_getBlockByNumber" && c.params[0] === Q(c.finalized) && ++anchors === 2) c.result.stateRoot = H(123); return c.result; } });
      const out = path.join(parent, String(expired)), writer = cli.createCensusWriter(out);
      const r = await run(f, { onChunk: writer.onChunk });
      const summary = writer.publish(r, cli.REGISTRY_SHA256, () => expired ? Date.parse(capture.EXPIRES_AT) : START_MS);
      assert.equal(summary.status, expired ? "LIMIT-REACHED" : "CAPTURE-FAILED");
      assert.equal(fs.existsSync(path.join(out, "scorecard.json")), false);
      assert.equal(fs.existsSync(path.join(out, "terminalmanifest.json")), true);
    }
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("publication expiry cannot downgrade an earlier integrity failure", async () => {
  const parent = temporary();
  try {
    const f = fixture({ hook(c) { if (c.index === 1 && multiBlock(c) && c.result.length) c.result[0].data = H(123); return c.result; } });
    const writer = cli.createCensusWriter(path.join(parent, "capture")), r = await run(f, { onChunk: writer.onChunk });
    assert.equal(r.status, "CAPTURE-FAILED");
    const summary = writer.publish(r, cli.REGISTRY_SHA256, () => Date.parse(capture.EXPIRES_AT));
    assert.equal(summary.status, "CAPTURE-FAILED");
    assert.equal(summary.reason, "consensus-mismatch");
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("fixed CLI has no trace, endpoint, window, method or limits overrides; pinned registry loads offline", () => {
  for (const arg of ["--window=30", "--trace", "--endpoint=https://invalid", "--method=eth_call", "--limits=99999", "--qualify"]) {
    assert.throws(() => cli.parseArgs(["--census", "--chain=1", "--out=new", arg]), /invalid-options/);
  }
  const loaded = cli.loadRegistryArtifact(1);
  assert.equal(loaded.registryArtifactSha256, cli.REGISTRY_SHA256);
  assert.equal(loaded.registry.chainId, 1);
  assert.equal(loaded.registry.sources.length, 8);
});

test("generic quota/auth/unknown RPC, method, HTTP and timeout failures never subdivide", async () => {
  for (const [label, code] of [["quota", "provider-rpc-failure"], ["auth", "provider-rpc-failure"], ["unknown", "provider-rpc-failure"],
    ["method", "provider-method-not-found"], ["http", "provider-http-failure"], ["timeout", "request-timeout"]]) {
    const f = fixture({ hook(c) {
      if (c.index === 0 && multiBlock(c)) { const error = new Error(code); error.privateContext = `${label}:${SENTINEL}`; throw error; }
      return c.result;
    } });
    const r = await run(f);
    assert.equal(r.reason, code, label);
    assert.equal(r.attemptedLogWindows, 1, label);
    assert.equal(f.calls.filter(multiBlock).length, 2, label);
    assert.equal(r.chunks.length, 0);
    assert.ok(!JSON.stringify(r).includes(SENTINEL));
  }
  const mixed = fixture({ hook(c) {
    if (multiBlock(c)) throw new Error(c.index === 0 ? "provider-log-range-restricted" : "provider-rpc-failure");
    return c.result;
  } });
  const r = await run(mixed);
  assert.equal(r.reason, "provider-rpc-failure");
  assert.equal(r.attemptedLogWindows, 1);
});

test("recognized one-block basic restriction retires only that preselection candidate", async () => {
  const f = fixture({ hook(c) { if (c.index === 0 && c.method === "eth_getLogs") throw new Error("provider-log-range-restricted"); return c.result; } });
  const r = await run(f);
  assert.equal(r.status, "COMPLETE", r.reason);
  assert.deepEqual(r.selectedAliases, ["obs-02", "obs-03"]);
  assert.equal(r.observations[0].reason, "provider-log-range-restricted");
  assert.equal(f.calls.filter(c => c.index === 0 && c.method === "eth_getLogs").length, 1);
});

test("paired malformed or contradictory evidence wins over the other provider's generic availability error", async () => {
  for (const firstFailure of [0, 1]) {
    const f = fixture({ hook(c) {
      if (multiBlock(c)) {
        if (c.index === firstFailure) throw new Error("provider-rpc-failure");
        return { malformed: SENTINEL };
      }
      return c.result;
    } });
    const r = await run(f);
    assert.equal(r.status, "CAPTURE-FAILED");
    assert.equal(r.reason, "tainted-log-response");
    assert.equal(r.aggregateEvidenceStatus, "INVALID");
    assert.equal(r.scorecardAllowed, false);
    assert.equal(r.attemptedLogWindows, 1);
  }
});

test("retained complete parent logs constrain overlapping child scopes after the other provider restricts range", async () => {
  for (const omitChild of [false, true]) {
    const f = fixture({ hook(c) {
      if (multiBlock(c)) {
        const size = BigInt(c.params[0].toBlock) - BigInt(c.params[0].fromBlock) + 1n;
        if (c.index === 1 && size > 2048n) throw new Error("provider-log-range-restricted");
        if (omitChild && size <= 2048n) return [];
      }
      return c.result;
    } });
    const r = await run(f);
    assert.equal(r.status, omitChild ? "CAPTURE-FAILED" : "COMPLETE", r.reason);
    if (omitChild) { assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.chunks.length, 0); }
    else { assert.equal(r.counts.events, 1); assert.ok(r.chunks.length > 13); }
  }
});

test("bidirectional binding rejects an omitted second matching emission in an already fetched receipt", async () => {
  const f = fixture({ events: [{ logIndex: 0 }, { logIndex: 1 }], hook(c) {
    if (multiBlock(c)) return c.result.slice(0, 1);
    return c.result;
  } });
  const r = await run(f);
  assert.equal(r.status, "CAPTURE-FAILED");
  assert.equal(r.reason, "binding-mismatch");
  assert.equal(r.failurePhase, "receipt-log-reconciliation");
  assert.equal(r.chunks.length, 0);
});

test("prior source's cached receipt exposes an omitted current-source emission even when getLogs is empty", async () => {
  const f = fixture({ sources: ["aave-v3", "aave-v4"], events: [{ sourceId: "aave-v3", logIndex: 0 }, { sourceId: "aave-v4", logIndex: 1 }], hook(c) {
    if (multiBlock(c) && c.params[0].address.includes(A)) return [];
    return c.result;
  } });
  const r = await run(f);
  assert.equal(r.status, "CAPTURE-FAILED");
  assert.equal(r.reason, "binding-mismatch");
  assert.equal(r.chunks.length, 1);
  assert.equal(r.chunks[0].sourceId, "aave-v3");
  assert.equal(r.scorecardAllowed, false);
  assert.equal(r.aggregateEvidenceStatus, "INVALID");
  assert.equal(r.validAggregate, false);
  assert.equal(f.calls.filter(c => c.method === "eth_getTransactionReceipt" && c.params[0] === f.txHash(f.first + 10)).length, 2);
});

function overlappingRegistry() {
  const reg = registry();
  reg.sources.push({ ...clone(reg.sources[0]), id: "aave-v3-overlap" });
  return reg;
}
test("overlapping source membership keeps one canonical owner, event, receipt and fee with immutable provenance refs", async () => {
  const f = fixture({ registry: overlappingRegistry() }), parent = temporary(), out = path.join(parent, "capture");
  try {
    const writer = cli.createCensusWriter(out), r = await run(f, { onChunk: writer.onChunk });
    assert.equal(r.status, "COMPLETE", r.reason);
    assert.equal(r.counts.events, 1);
    assert.equal(r.counts.uniqueTransactions, 1);
    assert.equal(r.chunks.flatMap(c => c.receipts).length, 1);
    assert.equal(r.membershipRefs.length, 1);
    const owner = r.chunks[0], member = r.chunks[1], ref = member.membershipRefs[0];
    assert.equal(owner.events.length, 1);
    assert.equal(member.events.length, 0);
    assert.equal(member.logs.length, 1);
    assert.equal(ref.ownerSourceId, "aave-v3");
    assert.equal(ref.sourceId, "aave-v3-overlap");
    assert.equal(ref.ownerChunk, 1);
    assert.equal(ref.decoderCompatibility, "compatible");
    assert.equal(ref.ambiguousSourceAttribution, true);
    const before = fs.readFileSync(path.join(out, "chunk00001.json"));
    writer.publish(r, cli.REGISTRY_SHA256, () => Date.parse(r.endedAt) + 1);
    assert.deepEqual(fs.readFileSync(path.join(out, "chunk00001.json")), before);
    const loaded = cli.readAuthoritativeCensus(out);
    assert.deepEqual(loaded.manifest.membershipRefs, [ref]);
    assert.equal(loaded.scorecard.scorecard.summary.inWindowEvents, 1);
    assert.equal(loaded.scorecard.scorecard.fees.knownFeeWeiSum, "42000");
    assert.equal(loaded.manifest.coverage.filter(row => row.status === "validated").length, 2);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("overlapping sources cannot turn conflicting canonical fields into a membership alias", async () => {
  const seen = new Map();
  const f = fixture({ registry: overlappingRegistry(), hook(c) {
    if (multiBlock(c) && c.result.length) {
      const count = (seen.get(c.index) || 0) + 1; seen.set(c.index, count);
      if (count === 2) c.result[0].data = H(123);
    }
    return c.result;
  } });
  const r = await run(f);
  assert.equal(r.status, "CAPTURE-FAILED");
  assert.equal(r.reason, "consensus-mismatch");
  assert.equal(r.chunks.length, 1);
  assert.deepEqual(r.membershipRefs, []);
});

test("a budget exhausted during final anchor recheck remains PARTIAL, never VALIDATED; reader opt-in is required", async () => {
  const baseline = await run(fixture()), parent = temporary();
  const f = fixture({ limits: { requests: baseline.budget.requests - 3 } });
  try {
    const out = path.join(parent, "partial"), writer = cli.createCensusWriter(out), r = await run(f, { onChunk: writer.onChunk });
    assert.equal(r.status, "LIMIT-REACHED");
    assert.equal(r.failurePhase, "final-anchor-recheck");
    assert.equal(r.finalAnchorRechecked, false);
    assert.equal(r.budget.requests, baseline.budget.requests - 3);
    assert.equal(r.chunks.length, baseline.chunks.length);
    assert.equal(r.aggregateEvidenceStatus, "PARTIAL");
    assert.equal(r.validAggregate, false);
    writer.publish(r, cli.REGISTRY_SHA256, () => Date.parse(r.endedAt) + 1);
    assert.throws(() => cli.readAuthoritativeCensus(out), /invalid-schema/);
    const loaded = cli.readAuthoritativeCensus(out, { allowPartial: true });
    assert.equal(loaded.authority.aggregateEvidenceStatus, "PARTIAL");
    assert.equal(loaded.scorecard.authority.captureId, loaded.manifest.captureId);
    assert.equal(loaded.scorecard.authority.finalAnchorRechecked, false);
    assert.equal(loaded.scorecard.authority.validAggregate, false);
    assert.ok(loaded.scorecard.scorecard.limitations.some(note => note.includes("aggregateEvidenceStatus=PARTIAL") && note.includes("finalAnchorRechecked=false")));
    const again = cli.readAuthoritativeCensus(out, { allowPartial: true, expectedManifestSha256: loaded.manifestSha256 });
    assert.equal(again.manifestSha256, loaded.manifestSha256);
    assert.throws(() => cli.readAuthoritativeCensus(out, { allowPartial: true, expectedManifestSha256: "0".repeat(64) }), /invalid-schema/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("orphan chunks and a passing-looking orphan scorecard are not aggregate authority", async () => {
  const parent = temporary(), out = path.join(parent, "orphan");
  try {
    const r = await run(fixture()), writer = cli.createCensusWriter(out);
    r.chunks.forEach(chunk => writer.onChunk(chunk));
    fs.writeFileSync(path.join(out, "scorecard.json"), JSON.stringify({ status: "COMPLETE", validAggregate: true }));
    assert.throws(() => cli.readAuthoritativeCensus(out, { allowPartial: true }), /invalid-schema/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("CAPTURE-FAILED terminal authority overrides forged scorecardAllowed and validAggregate flags", async () => {
  const parent = temporary(), out = path.join(parent, "failed");
  let anchors = 0;
  try {
    const f = fixture({ hook(c) { if (c.index === 0 && c.method === "eth_getBlockByNumber" && c.params[0] === Q(c.finalized) && ++anchors === 2) c.result.stateRoot = H(123); return c.result; } });
    const writer = cli.createCensusWriter(out), r = await run(f, { onChunk: writer.onChunk });
    writer.publish({ ...r, scorecardAllowed: true }, cli.REGISTRY_SHA256, () => Date.parse(r.endedAt) + 1);
    assert.equal(fs.existsSync(path.join(out, "scorecard.json")), false);
    const file = path.join(out, "terminalmanifest.json"), m = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(m.aggregateEvidenceStatus, "INVALID");
    assert.equal(m.validAggregate, false);
    m.scorecardAllowed = true; m.validAggregate = true; m.aggregateEvidenceStatus = "VALIDATED"; m.integrityFailure = false;
    fs.writeFileSync(path.join(out, "scorecard.json"), JSON.stringify({ status: "COMPLETE" }));
    fs.writeFileSync(file, JSON.stringify(m));
    assert.throws(() => cli.readAuthoritativeCensus(out, { allowPartial: true }), /invalid-schema/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("authoritative reader rejects forged schema/status, chunk/scorecard hashes, and path-bearing manifest entries", async () => {
  const parent = temporary(), out = path.join(parent, "complete");
  try {
    const writer = cli.createCensusWriter(out), r = await run(fixture(), { onChunk: writer.onChunk });
    writer.publish(r, cli.REGISTRY_SHA256, () => Date.parse(r.endedAt) + 1);
    const manifestFile = path.join(out, "terminalmanifest.json"), original = fs.readFileSync(manifestFile, "utf8");
    const base = JSON.parse(original);
    for (const mutate of [m => { m.schema = "fake"; }, m => { m.finalAnchorRechecked = false; }, m => { m.runtimeDrained = false; },
      m => { m.publicationExpired = true; }, m => { m.validAggregate = false; }, m => { m.counts.events++; },
      m => { m.chunks[0].sha256 = "0".repeat(64); }, m => { m.scorecardFiles.jsonSha256 = "0".repeat(64); },
      m => { delete m.scorecardFiles.markdownSha256; }, m => { m.scorecardFiles.jsonFile = "../.env"; }, m => { m.chunks[0].file = "../rpc_endpoints.txt"; }]) {
      const m = clone(base); mutate(m);
      // Even recomputing the non-secret capture ID must not bypass field/path/hash checks.
      m.captureId = `c1-${m.chainId}-${capture.sha256(capture.canonical({ registryArtifactSha256: m.registryArtifactSha256, chunks: m.chunks, startedAt: m.startedAt })).slice(0, 16)}`;
      fs.writeFileSync(manifestFile, JSON.stringify(m));
      assert.throws(() => cli.readAuthoritativeCensus(out, { allowPartial: true }), /invalid-schema/);
    }
    fs.writeFileSync(manifestFile, original);
    const chunkFile = path.join(out, "chunk00001.json"), bytes = fs.readFileSync(chunkFile);
    fs.appendFileSync(chunkFile, " ");
    assert.throws(() => cli.readAuthoritativeCensus(out), /invalid-schema/);
    fs.writeFileSync(chunkFile, bytes);
    assert.equal(cli.readAuthoritativeCensus(out).authority.aggregateEvidenceStatus, "VALIDATED");
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("authoritative reader rejects a symlinked chunk even when bytes match the manifest hash", async t => {
  const parent = temporary(), out = path.join(parent, "complete");
  try {
    const writer = cli.createCensusWriter(out), r = await run(fixture(), { onChunk: writer.onChunk });
    writer.publish(r, cli.REGISTRY_SHA256, () => Date.parse(r.endedAt) + 1);
    const chunk = path.join(out, "chunk00001.json"), outside = path.join(parent, "outside-public.json");
    fs.copyFileSync(chunk, outside); fs.unlinkSync(chunk);
    try { fs.symlinkSync(outside, chunk, "file"); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("Windows file symlink privilege unavailable"); return; } throw error; }
    assert.throws(() => cli.readAuthoritativeCensus(out), /invalid-schema/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

function c2Fixture(options = {}) {
  const f = fixture(options), original = f.options.transport, origins = [];
  f.options = { ...f.options, transport: undefined, backoffRandom: () => 0, fetch: async (url, init) => {
    const request = JSON.parse(init.body), index = f.options.candidates.indexOf(url);
    origins.push(init.headers.Origin); assert.equal(init.redirect, "error");
    const { result } = await original({ provider: { url }, method: request.method, params: request.params });
    const response = options.httpHook ? await options.httpHook({ index, method: request.method, params: request.params, id: request.id, result, f }) : {};
    return new Response(response.raw === undefined ? JSON.stringify({ jsonrpc: "2.0", id: request.id,
      ...(response.error ? { error: response.error } : { result: Object.hasOwn(response, "result") ? response.result : result }) }) : response.raw,
    { status: response.status || 200, headers: response.headers });
  } };
  return { ...f, origins };
}
const runC2 = (f, extras = {}) => run(f, { authorizedBackoff: true, ...extras });

test("C2 is an Ethereum-only opt-in; legacy C1 has no mode, diagnostics or backoff fields", async () => {
  const legacy = await run(fixture()), f = c2Fixture(), result = await runC2(f);
  assert.equal(result.status, "COMPLETE", result.reason); assert.equal(result.mode, "authorized-backoff"); assert.equal(result.backoffEnabled, true);
  assert.equal(result.runtimeDrained, true); assert.equal(result.backoff.activeOperations, 0); assert.equal(result.backoff.pendingRuns, 0);
  assert.deepEqual(result.chunks, legacy.chunks); assert.deepEqual(result.coverage, legacy.coverage);
  assert.equal(result.fixture.header.number, String(capture.FIXTURES[1].number));
  assert.equal(result.window.startTimestamp, String(T - 604800n)); assert.equal(result.window.endTimestampExclusive, String(T));
  assert.deepEqual(result.limits, { ...C2_LIMITS, ...CAPS }); assert.equal(result.limits.spacingMs, 1000); assert.equal(result.limits.concurrency, 2);
  assert.equal(result.budget.requests, f.calls.length); assert.equal(result.transportDiagnostics.length, f.calls.length); assert.equal(result.budget.traceRequests, 0);
  assert.ok(result.transportDiagnostics.every(event => C2_PHASES.includes(event.phase) && event.attempt === 1 && event.httpStatus === 200));
  assert.ok(result.transportDiagnostics.filter(event => event.method === "eth_getLogs" && event.phase !== "fixture-logs").every(event => event.phase === "census-logs"));
  const firstTx = f.calls.findIndex(call => call.method === "eth_getTransactionByHash"), firstRange = f.calls.findIndex(multiBlock);
  for (let index = 0; index < 3; index++) {
    assert.ok(f.calls.findIndex(call => call.index === index && call.method === "eth_getLogs") < firstTx);
    assert.ok(f.calls.findIndex(call => call.index === index && call.method === "eth_getTransactionReceipt") < firstRange);
  }
  assert.ok(f.calls.slice(firstRange).every(call => call.index !== 2));
  assert.equal(aggregate(result).fees.knownFeeWeiSum, "42000");
  for (const key of ["mode", "backoffEnabled", "backoff", "transportDiagnostics"]) assert.equal(Object.hasOwn(legacy, key), false);
  assert.ok(!/SECRET_TOKEN|alchemy|infura|publicnode|https:/.test(JSON.stringify(result)));
  await assert.rejects(runC2(c2Fixture({ chainId: 8453 })), /invalid-options/);
  await assert.rejects(runCensus({ chainId: 1, registry: registry(), authorizedBackoff: true }), /invalid-options/);
  await assert.rejects(runCensus({ chainId: 1, registry: registry(), authorizedBackoff: "true" }), /invalid-options/);
  assert.throws(() => cli.parseArgs(["--census", "--authorized-backoff", "--chain=8453", "--out=new"]), /invalid-options/);
  assert.equal(cli.parseArgs(["--census", "--authorized-backoff", "--chain=1", "--out=new"]).authorizedBackoff, true);
});

test("C2 preselection rate exhaustion retires a candidate and shared family circuit prevents another credential call", async () => {
  const f = c2Fixture({ candidates: [`https://eth.alchemy.com/a-${SENTINEL}`, `https://eth.alchemy.com/b-${SENTINEL}`, "https://eth.infura.io/offline", "https://ethereum.publicnode.com/offline"],
    httpHook: call => call.index === 0 ? { status: 429, raw: SENTINEL, headers: { "retry-after": "1" } } : {},
  });
  const r = await runC2(f);
  assert.equal(r.status, "COMPLETE", r.reason); assert.deepEqual(r.selectedAliases, ["obs-03", "obs-04"]);
  assert.equal(f.calls.filter(call => call.index === 0).length, 3); assert.equal(f.calls.filter(call => call.index === 1).length, 0);
  assert.equal(r.observations[1].reason, "provider-circuit-open"); assert.equal(r.backoff.retries, 2); assert.equal(r.backoff.openCircuits, 1);
  assert.deepEqual(r.transportDiagnostics.filter(event => event.httpStatus === 429).map(event => [event.phase, event.attempt, event.code]),
    [["chain-id", 1, "provider-http-failure"], ["chain-id", 2, "provider-http-failure"], ["chain-id", 3, "provider-http-failure"]]);
  assert.ok(!JSON.stringify(r).includes(SENTINEL));
});

test("C2 retains preselection transaction evidence across a later exhausted receipt request", async () => {
  const f = c2Fixture({ hook(call) { if (call.index === 0 && call.method === "eth_getTransactionByHash") call.result.nonce = "0x2"; return call.result; },
    httpHook: call => call.index === 0 && call.method === "eth_getTransactionReceipt" ? { status: 429, raw: SENTINEL } : {},
  });
  const r = await runC2(f);
  assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.scorecardAllowed, false);
  assert.equal(r.observations[0].transaction, "passed"); assert.equal(r.observations[0].receipt, "failed");
  assert.equal(r.transportDiagnostics.filter(event => event.httpStatus === 429 && event.phase === "receipt-read").length, 3);
  assert.equal(r.chunks.length, 0);
});

test("C2 selected-pair 429 exhaustion is terminal with no replacement or subdivision; recovery repeats only the same query", async () => {
  for (const recover of [false, true]) {
    let seen = 0;
    const f = c2Fixture({ httpHook(call) {
      if (call.index === 0 && multiBlock(call) && (++seen === 1 || !recover)) return { status: 429, raw: SENTINEL, headers: { "retry-after": "1" } };
      return {};
    } });
    const r = await runC2(f), firstRange = f.calls.findIndex(multiBlock), left = f.calls.filter(call => call.index === 0 && multiBlock(call));
    assert.deepEqual(r.selectedAliases, ["obs-01", "obs-02"]); assert.ok(f.calls.slice(firstRange).every(call => call.index !== 2));
    assert.deepEqual(left[0], left[1]);
    assert.equal(r.limits.concurrency, 2);
    const firstQuery = capture.canonical(left[0].params);
    assert.equal(left.filter(call => capture.canonical(call.params) === firstQuery).length, recover ? 2 : 3);
    assert.equal(f.calls.filter(call => call.index === 1 && call.method === "eth_getLogs" && capture.canonical(call.params) === firstQuery).length, 1,
      "the successful concurrent paired-query leg must not be resent when only its counterpart receives HTTP 429");
    assert.ok(r.transportDiagnostics.filter(event => event.httpStatus === 429).every(event => event.phase === "census-logs"));
    if (recover) { assert.equal(r.status, "COMPLETE", r.reason); assert.equal(r.counts.events, 1); assert.equal(r.backoff.retries, 1); }
    else {
      assert.equal(r.status, "ACCESS-BLOCKED"); assert.match(r.reason, /provider-rate-limited|provider-circuit-open/);
      assert.equal(left.length, 3); assert.equal(r.attemptedLogWindows, 1); assert.equal(r.chunks.length, 0); assert.equal(r.backoff.retries, 2);
    }
    assert.equal(r.budget.requests, f.calls.length); assert.equal(r.transportDiagnostics.length, f.calls.length);
  }
});

test("C2 keeps explicit RPC range subdivision, but HTTP 400 and global limits never authorize it", async () => {
  for (const status of [200, 400]) {
    const f = c2Fixture({ httpHook: call => multiBlock(call) && BigInt(call.params[0].toBlock) - BigInt(call.params[0].fromBlock) + 1n > 2048n
      ? { status, error: { code: -32005, message: "block range is too large" } } : {} });
    const r = await runC2(f);
    if (status === 200) { assert.equal(r.status, "COMPLETE", r.reason); assert.ok(r.chunks.length > 13); }
    else { assert.equal(r.reason, "provider-http-failure"); assert.equal(r.attemptedLogWindows, 1); assert.equal(r.chunks.length, 0); }
    assert.equal(r.backoff.retries, 0);
  }
  const f = c2Fixture({ limits: { requests: 1 }, httpHook: () => ({ status: 429, raw: SENTINEL }) }), r = await runC2(f);
  assert.equal(r.status, "LIMIT-REACHED"); assert.equal(r.reason, "request-budget-exhausted"); assert.equal(f.calls.length, 1);
  assert.equal(r.transportDiagnostics[0].httpStatus, 429); assert.equal(r.limits.requests, 1); assert.equal(r.backoff.retries, 0);
});

test("C2 integrity survives a later shutdown expiry rather than becoming usable partial evidence", async () => {
  const f = c2Fixture({ hook(call) { if (call.index === 1 && multiBlock(call)) return { malformed: SENTINEL }; return call.result; } });
  const original = capture.createRuntime;
  capture.createRuntime = options => {
    const runtime = original(options);
    return Object.freeze({ ...runtime, close: async () => { await runtime.close(); f.setNow(Date.parse(capture.EXPIRES_AT)); } });
  };
  try {
    const r = await runC2(f);
    assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "tainted-log-response"); assert.equal(r.lifecycleFailure, "session-expired");
    assert.equal(r.aggregateEvidenceStatus, "INVALID"); assert.equal(r.scorecardAllowed, false); assert.equal(r.runtimeDrained, true);
  } finally { capture.createRuntime = original; }
});

test("C2 CLI verifies registry/output/expiry before loading and disposes the adapter after drain but before publication", async () => {
  const parent = temporary(), out = path.join(parent, "c2"), f = c2Fixture(), order = [], printed = [];
  try {
    const code = await cli.main(["--census", "--authorized-backoff", "--chain=1", `--out=${out}`], {
      createCensusWriter(directory) { const writer = cli.createCensusWriter(directory); order.push("reserved"); return { ...writer, publish(...args) { assert.equal(order.at(-1), "disposed"); order.push("published"); return writer.publish(...args); } }; },
      loadRegistryArtifact() { assert.ok(fs.existsSync(out)); order.push("registry"); return { registry: f.registry, registryArtifactSha256: cli.REGISTRY_SHA256 }; },
      loadAuthorizedCandidates(options) { assert.deepEqual(options, { chainId: 1, cap: 16 }); assert.equal(order.at(-1), "registry"); order.push("loaded"); return {
        candidates: f.options.candidates, getOrigin: () => "https://owned-origin.invalid", dispose() { assert.equal(order.at(-1), "drained"); order.push("disposed"); }, toJSON() { throw new Error(SENTINEL); },
      }; },
      async runCensus(options) { assert.equal(options.authorizedBackoff, true); const result = await runCensus({ ...options, runtimeOptions: { ...f.options, ...options.runtimeOptions } }); assert.equal(result.runtimeDrained, true); order.push("drained"); return result; },
      now: f.options.now, print: value => printed.push(value),
    });
    assert.equal(code, 0); assert.deepEqual(order, ["reserved", "registry", "loaded", "drained", "disposed", "published"]);
    assert.ok(f.origins.every(origin => origin === "https://owned-origin.invalid"));
    const loaded = cli.readAuthoritativeCensus(out); assert.match(loaded.manifest.captureId, /^c2-1-/);
    assert.equal(loaded.manifest.mode, "authorized-backoff"); assert.equal(loaded.authority.validAggregate, true);
    assert.ok(!/owned-origin|https:|SECRET_TOKEN/.test(JSON.stringify(loaded))); assert.ok(!/https:|SECRET_TOKEN/.test(printed.join("")));
    let loads = 0;
    for (const [name, args, now, hash] of [
      ["base", ["--chain=8453"], START_MS, cli.REGISTRY_SHA256], ["expired", ["--chain=1"], Date.parse(capture.EXPIRES_AT), cli.REGISTRY_SHA256],
      ["hash", ["--chain=1"], START_MS, "0".repeat(64)], ["c2", ["--chain=1"], START_MS, cli.REGISTRY_SHA256],
    ]) {
      assert.equal(await cli.main(["--census", "--authorized-backoff", ...args, `--out=${path.join(parent, name)}`], {
        loadRegistryArtifact: () => ({ registry: f.registry, registryArtifactSha256: hash }), loadAuthorizedCandidates() { loads++; throw new Error(SENTINEL); }, now: () => now, print() {},
      }), 2);
    }
    assert.equal(loads, 0);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("C2 CLI disposes on runtime throws and initialization failures; disposal failure prohibits publication", async () => {
  for (const mode of ["throw", "initialize", "dispose", "load"]) {
    const f = c2Fixture(), order = [], printed = [];
    const code = await cli.main(["--census", "--authorized-backoff", "--chain=1", "--out=synthetic"], {
      createCensusWriter: () => ({ onChunk() {}, publish(result) { order.push("published"); return { status: result.status }; } }),
      loadRegistryArtifact: () => ({ registry: f.registry, registryArtifactSha256: cli.REGISTRY_SHA256 }),
      loadAuthorizedCandidates() {
        if (mode === "load") throw new Error(SENTINEL);
        return { candidates: f.options.candidates, getOrigin: () => null, dispose() { order.push("disposed"); if (mode === "dispose") throw new Error(SENTINEL); } };
      },
      async runCensus(options) {
        if (mode === "throw") throw new Error(SENTINEL);
        const result = await runCensus({ ...options, runtimeOptions: { ...f.options, ...options.runtimeOptions, ...(mode === "initialize" ? { backoffRandom: 1 } : {}) } });
        assert.equal(result.runtimeDrained, true); order.push("drained"); return result;
      }, now: f.options.now, print: value => printed.push(value),
    });
    assert.equal(code, 2); assert.ok(!printed.join("").includes(SENTINEL));
    assert.deepEqual(order, mode === "load" ? [] : mode === "throw" ? ["disposed"] : mode === "initialize" ? ["drained", "disposed", "published"] : ["drained", "disposed"]);
  }
});

test("C2 authority supports valid partial output and rejects forged mode, backoff, diagnostics and chunk hashes", async () => {
  const parent = temporary(), out = path.join(parent, "c2");
  try {
    const f = c2Fixture({ httpHook: call => call.index === 0 && multiBlock(call) && BigInt(call.params[0].fromBlock) > BigInt(call.f?.first ?? f.first)
      ? { status: 503, raw: SENTINEL } : {} });
    const writer = cli.createCensusWriter(out), result = await runC2(f, { onChunk: writer.onChunk });
    assert.equal(result.status, "ACCESS-BLOCKED"); assert.ok(result.chunks.length > 0);
    writer.publish(result, cli.REGISTRY_SHA256, () => Date.parse(result.endedAt) + 1);
    assert.throws(() => cli.readAuthoritativeCensus(out), /invalid-schema/);
    assert.equal(cli.readAuthoritativeCensus(out, { allowPartial: true }).authority.aggregateEvidenceStatus, "PARTIAL");
    const file = path.join(out, "terminalmanifest.json"), text = fs.readFileSync(file, "utf8"), base = JSON.parse(text);
    for (const mutate of [m => { m.mode = "unknown"; }, m => { m.backoffEnabled = false; }, m => { delete m.mode; },
      m => { m.limits.spacingMs = 300; }, m => { m.backoff.retries = 17; }, m => { m.backoff.activeOperations = 1; },
      m => { m.transportDiagnostics[0].raw = SENTINEL; }, m => { m.transportDiagnostics[0].phase = SENTINEL; },
      m => { m.chunks[0].sha256 = "0".repeat(64); }, m => { m.publicationExpired = true; }, m => { m.integrityFailure = true; }]) {
      const manifest = clone(base); mutate(manifest);
      manifest.captureId = `c2-1-${capture.sha256(capture.canonical({ registryArtifactSha256: manifest.registryArtifactSha256, chunks: manifest.chunks, startedAt: manifest.startedAt,
        mode: manifest.mode, backoffEnabled: manifest.backoffEnabled, ownerAuthorization: manifest.ownerAuthorization, limits: manifest.limits, budget: manifest.budget,
        backoff: manifest.backoff, transportDiagnostics: manifest.transportDiagnostics })).slice(0, 16)}`;
      fs.writeFileSync(file, JSON.stringify(manifest));
      assert.throws(() => cli.readAuthoritativeCensus(out, { allowPartial: true }), /invalid-schema/);
    }
    fs.writeFileSync(file, text); assert.equal(cli.readAuthoritativeCensus(out, { allowPartial: true }).manifest.captureId, base.captureId);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
