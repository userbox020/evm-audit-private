"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseRpcInventory } = require("../shared-rpc");
const { FIXTURES, LIQUIDATION_TOPIC, EXPIRES_AT, normalizeLogs, canonical, sha256 } = require("../strategy-study/capture");
const { publicRouteCandidate, runDiagnostics, main, parseArgs, D1_LIMITS, D1_RANGES, D1_METHODS, D1_PHASES, D2_LIMITS, D2_METHODS, D2_PHASES } = require("../strategy-study/diagnose-cli");

const START = Date.parse("2026-10-20T03:00:00Z");
const TOKEN = "D1_RESPONSE_SECRET_SENTINEL";
const H = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const Q = n => `0x${BigInt(n).toString(16)}`;
const TX_BASE = 1n << 90n;

function temp(t) {
  const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "Temp", "opencode");
  fs.mkdirSync(base, { recursive: true });
  const parent = fs.mkdtempSync(path.join(base, "strategy-study-d1-offline-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return path.join(parent, "capture");
}
function fixture(t, settings = {}) {
  const chainId = settings.chainId || 1, range = D1_RANGES[chainId];
  const authorized = settings.authorizedBackoff === true;
  const routes = settings.routes || (authorized ? [`https://eth.g.alchemy.com/synthetic-${TOKEN}`, `https://eth.infura.io/synthetic-${TOKEN}`, "https://ethereum.publicnode.com"]
    : chainId === 1 ? ["https://ethereum.publicnode.com", "https://1rpc.io/eth", "https://eth.drpc.org"] : ["https://base.publicnode.com", "https://1rpc.io/base", "https://base.drpc.org"]);
  const normalizedRoutes = [...new Set(routes.map(value => value.endsWith("/") ? value.slice(0, -1) : value))];
  const calls = [], out = temp(t);
  let clock = START, loads = 0, disposals = 0;
  const txHash = (number, index = 0) => H(TX_BASE + BigInt(number) + BigInt(index) * (1n << 64n));
  function block(number) {
    return { number: Q(number), hash: H(number + 1), parentHash: H(number), stateRoot: H((1n << 100n) + BigInt(number)),
      timestamp: Q(1792454400n + BigInt(number - range.toBlock) * 12n), transactions: Array.from({ length: settings.fixtureTransactions || 1 }, (_, index) => txHash(number, index)) };
  }
  function transaction(hash) {
    const encoded = BigInt(hash) - TX_BASE, number = Number(encoded % (1n << 64n)), index = Number(encoded / (1n << 64n));
    return { hash, blockHash: H(number + 1), blockNumber: Q(number), transactionIndex: Q(index), from: "0x" + "11".repeat(20), to: "0x" + "22".repeat(20),
      value: "0x0", type: index < (settings.deposits || 0) ? "0x7e" : "0x2", nonce: "0x1", gas: "0x5208", input: "0x", chainId: Q(chainId) };
  }
  function receipt(hash) {
    const tx = transaction(hash);
    return { transactionHash: hash, blockHash: tx.blockHash, blockNumber: tx.blockNumber, transactionIndex: tx.transactionIndex, from: tx.from, to: tx.to,
      type: tx.type, status: settings.receiptStatus || "0x1", gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logs: [] };
  }
  function log(number, index = 0) {
    return { address: FIXTURES[chainId].address, topics: [LIQUIDATION_TOPIC, H(1)], data: H(index + 1), blockNumber: Q(number), blockHash: H(number + 1),
      transactionHash: txHash(number), transactionIndex: "0x0", logIndex: Q(index), removed: false };
  }
  const shared = {
    getOrigin: settings.getOrigin || (() => null),
    loadRpcUrls(options) {
      loads++;
      assert.ok(fs.statSync(out).isDirectory(), "exclusive directory must precede inventory loading");
      assert.equal(options.preferredChainId, chainId); assert.equal(options.maxCandidates, settings.limits?.candidatePool || 8); assert.equal(options.file, undefined);
      return settings.ignoreFilter ? routes : parseRpcInventory(routes.join("\n"), options);
    },
  };
  function loadAuthorizedCandidates({ chainId: requestedChain, cap }) {
    loads++;
    assert.ok(fs.statSync(out).isDirectory()); assert.equal(requestedChain, chainId); assert.equal(cap, settings.limits?.candidatePool || 16);
    return { candidates: routes.slice(), getOrigin: value => settings.getOrigin ? settings.getOrigin(value) : null,
      dispose() { disposals++; settings.onDispose?.(); }, toJSON() { throw new Error(TOKEN); } };
  }
  async function fetch(_url, init) {
    assert.equal(init.headers.Origin, authorized ? settings.getOrigin?.(_url) || undefined : undefined, "only adapter-declared Origin");
    assert.equal(init.redirect, "error");
    const index = normalizedRoutes.indexOf(_url), request = JSON.parse(init.body);
    assert.ok(index >= 0);
    const call = { index, method: request.method, params: request.params };
    calls.push(call);
    let result;
    switch (request.method) {
      case "eth_chainId": result = Q(chainId); break;
      case "eth_getBlockByNumber": result = block(request.params[0] === "finalized" ? range.toBlock + 1000 : Number(BigInt(request.params[0]))); break;
      case "eth_getBlockByHash": result = block(Number(BigInt(request.params[0])) - 1); break;
      case "eth_getLogs": result = (settings.events || []).filter(number => BigInt(number) >= BigInt(request.params[0].fromBlock) && BigInt(number) <= BigInt(request.params[0].toBlock)).map(number => log(number)); break;
      case "eth_getTransactionByHash": assert.ok(authorized); result = transaction(request.params[0]); break;
      case "eth_getTransactionReceipt": assert.ok(authorized); result = receipt(request.params[0]); break;
      default: assert.fail("unexpected D1 method");
    }
    const response = settings.hook ? await settings.hook({ ...call, requestId: request.id, result: structuredClone(result), log, block, transaction, receipt, range, signal: init.signal, setNow: value => { clock = value; } }) : { result };
    if (response instanceof Response) return response;
    const payload = { jsonrpc: "2.0", id: request.id, ...(response?.error ? { error: response.error } : { result: response && Object.hasOwn(response, "result") ? response.result : result }) };
    return new Response(JSON.stringify(payload), { status: response?.status || 200, headers: response?.headers });
  }
  return { calls, out, block, log, txHash, transaction, receipt, range, routes, loads: () => loads, disposals: () => disposals, setNow: value => { clock = value; }, options: {
    chainId, out, shared, fetch, now: () => clock, sleep: async ms => { clock += ms; }, ...(settings.limits ? { limits: settings.limits } : {}),
    ...(authorized ? { authorizedBackoff: true, loadAuthorizedCandidates, backoffRandom: () => 0 } : {}),
  } };
}
async function run(t, settings) { const f = fixture(t, settings); return { ...f, result: await runDiagnostics(f.options) }; }
const rpcError = (status, code, message) => ({ status, error: { code, message } });

test("public routes are exact chain-specific keyless paths, never private or credential-bearing aliases", () => {
  for (const url of ["https://ethereum.publicnode.com", "https://ethereum-rpc.publicnode.com/", "https://eth.drpc.org/", "https://ethereum.drpc.org", "https://ethereum.drpc.org/", "https://1rpc.io/eth", "https://0xrpc.io/eth", "https://docs-demo.quiknode.pro/"]) assert.equal(publicRouteCandidate(url, 1), true);
  for (const url of ["https://base.publicnode.com/", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://docs-demo.base-mainnet.quiknode.pro", "https://docs-demo.base-mainnet.quiknode.pro/", "https://1rpc.io/base", "https://0xrpc.io/base"]) assert.equal(publicRouteCandidate(url, 8453), true);
  for (const url of [
    "https://ethereum.publicnode.com?key=secret", "https://ethereum.publicnode.com?", "https://ethereum.publicnode.com#", "https://ethereum.publicnode.com:443/",
    "https://user@ethereum.publicnode.com/", "https://:password@ethereum.publicnode.com/", "http://ethereum.publicnode.com/", "https://ethereum.publicnode.com./", "https://ethereum.publicnode.com.evil.invalid/",
    "https://ethereum.publicnode.com/token", "https://ethereum.publicnode.com/path/../", "https://ethereum.publicnode.com//", "https://1rpc.io/eth/", "https://1rpc.io/eth/token", "https://0xrpc.io/%65th",
    "https://custom.quiknode.pro/", "https://docs-demo.quiknode.pro/key", "https://docs-demo.base-mainnet.quiknode.pro", "https://opaque.alchemy.com/secret", "https://app.aave.com/api/rpc-proxy",
    "https://app.morpho.org/api/rpc", "https://gateway.tenderly.co/", "https://base.publicnode.com", "https://1rpc.io/base", "https://placeholder.invalid", "https://YOUR-ENDPOINT",
  ]) assert.equal(publicRouteCandidate(url, 1), false, "nonpublic or wrong-chain route must be rejected");
  for (const url of [
    "https://docs-demo.base-mainnet.quiknode.pro/key", "https://docs-demo.base-mainnet.quiknode.pro?key=secret",
    "https://docs-demo.base-mainnet.quiknode.pro#fragment", "https://user@docs-demo.base-mainnet.quiknode.pro",
    "https://docs-demo.base-mainnet.quiknode.pro:443/", "https://custom.base-mainnet.quiknode.pro/",
    "https://docs-demo.base-mainnet.quiknode.pro.evil.invalid/", "https://ethereum.drpc.org",
  ]) assert.equal(publicRouteCandidate(url, 8453), false, "Base demo admission must remain exact and keyless");
  assert.equal(publicRouteCandidate("https://ethereum.drpc.org/key", 1), false);
  assert.equal(publicRouteCandidate("https://ethereum.drpc.org?key=secret", 1), false);
  assert.equal(publicRouteCandidate("https://docs-demo.quiknode.pro", 8453), false);
  assert.equal(publicRouteCandidate("https://1rpc.io/base", "1"), false);
});

test("full basic pool precedes fixed four log probes; paired empty results are capability-only evidence", async t => {
  const f = await run(t), { report } = f.result;
  assert.equal(report.status, "DIAGNOSTIC-COMPLETE"); assert.equal(report.publicKeylessOnly, true);
  const firstLog = f.calls.findIndex(call => call.method === "eth_getLogs");
  assert.equal(firstLog, 18);
  for (let index = 0; index < 3; index++) assert.equal(f.calls.slice(0, firstLog).filter(call => call.index === index).length, 6);
  assert.equal(report.budget.requests, 54); assert.equal(report.budget.logRequests, 12); assert.equal(report.budget.traceRequests, 0);
  assert.equal(report.transportDiagnostics.length, report.budget.requests);
  assert.ok(report.transportDiagnostics.every(event => Object.isFrozen(event) && D1_PHASES.includes(event.phase)));
  assert.ok(report.transportDiagnostics.slice(0, firstLog).every(event => event.probeId === null));
  assert.ok(f.calls.every(call => D1_METHODS.includes(call.method)));
  for (let index = 0; index < 3; index++) {
    const probes = f.calls.filter(call => call.index === index && call.method === "eth_getLogs");
    assert.deepEqual(probes.map(call => Number(BigInt(call.params[0].toBlock)) - Number(BigInt(call.params[0].fromBlock)) + 1), [1, 256, 4096, 256]);
    assert.deepEqual(probes.map(call => Array.isArray(call.params[0].address)), [true, true, true, false]);
    assert.ok(probes.every(call => call.params[0].topics[0][0] === LIQUIDATION_TOPIC));
    const events = report.transportDiagnostics.filter(event => event.observationId === `obs-0${index + 1}`);
    assert.deepEqual(events.filter(event => event.method === "eth_getLogs").map(event => [event.phase, event.probeId]),
      ["one-block-array", "short-array", "full-array", "short-scalar"].map(id => [id, id]));
    for (const id of ["one-block-array", "short-array", "full-array", "short-scalar"]) {
      assert.deepEqual(events.filter(event => event.probeId === id).map(event => event.phase), [id, "probe-start-header", "probe-end-header"]);
    }
  }
  assert.ok(report.capabilities.probes.every(probe => probe.status === "accepted" && probe.eventCount === 0 && probe.nonemptyExercised === false));
  assert.equal(report.capabilities.headerByNumber.status, "accepted"); assert.equal(report.capabilities.headerByHash.status, "accepted");
  assert.equal(report.censusComplete, false); assert.equal(report.profitKnown, false); assert.equal(report.receiptBinding, false); assert.equal(report.cryptographicAncestryProof, false);
  assert.equal(report.terminal, true); assert.equal(report.expiresAt, EXPIRES_AT);
  assert.equal(f.result.sha256, sha256(canonical({ captureId: f.result.captureId, report })));
  const artifact = fs.readFileSync(path.join(f.out, "diagnostics.json"), "utf8");
  assert.equal(artifact, canonical(f.result) + "\n"); assert.ok(!/https:|publicnode|drpc|1rpc/.test(artifact));
});

test("Base wrong chain receives no target reads and correct independent routes qualify its exact span", async t => {
  const f = await run(t, { chainId: 8453, routes: ["https://docs-demo.base-mainnet.quiknode.pro", "https://1rpc.io/base", "https://base.drpc.org"],
    hook: call => ({ result: call.index === 0 && call.method === "eth_chainId" ? "0x1" : call.result }) });
  assert.equal(f.result.report.status, "DIAGNOSTIC-COMPLETE");
  assert.deepEqual(f.calls.filter(call => call.index === 0).map(call => call.method), ["eth_chainId"]);
  assert.equal(f.result.report.observations[0].reason, "wrong-chain");
  const full = f.calls.find(call => call.method === "eth_getLogs" && Number(BigInt(call.params[0].toBlock)) - Number(BigInt(call.params[0].fromBlock)) === 16383);
  assert.equal(full.params[0].fromBlock, Q(52700000)); assert.equal(full.params[0].toBlock, Q(52716383));
});

test("same-family routes cannot authorize log probing or expose single-provider headers", async t => {
  const f = await run(t, { routes: ["https://ethereum.publicnode.com", "https://ethereum-rpc.publicnode.com"] });
  assert.equal(f.result.report.status, "ACCESS-BLOCKED");
  assert.equal(f.result.report.reason, "independent-pair-unavailable");
  assert.equal(f.calls.filter(call => call.method === "eth_getLogs").length, 0);
  assert.deepEqual(f.result.report.capabilities.headerByNumber, { status: "unknown" });
  assert.ok(!canonical(f.result.report.capabilities).includes("eventCount"));
  assert.ok(fs.existsSync(path.join(f.out, "diagnostics.json")));
});

test("empty inventory never appends fallback URLs; slash duplicates are removed before the cap", async t => {
  const empty = await run(t, { routes: [] });
  assert.equal(empty.loads(), 1); assert.equal(empty.calls.length, 0); assert.equal(empty.result.report.observations.length, 0);
  const duplicate = await run(t, { routes: ["https://ethereum.publicnode.com", "https://ethereum.publicnode.com/", "https://1rpc.io/eth", "https://eth.drpc.org"] });
  assert.equal(duplicate.result.report.observations.length, 3);
  assert.equal(duplicate.result.report.status, "DIAGNOSTIC-COMPLETE");
});

test("Origin-required and private candidates cannot bypass the public admission guard", async t => {
  const filtered = await run(t, { getOrigin: () => "https://private-origin.invalid" });
  assert.equal(filtered.calls.length, 0); assert.equal(filtered.result.report.status, "ACCESS-BLOCKED");
  const ignored = await run(t, { ignoreFilter: true, routes: [`https://opaque.alchemy.com/${TOKEN}`] });
  assert.equal(ignored.result.report.status, "CAPTURE-FAILED"); assert.equal(ignored.calls.length, 0);
  assert.ok(!canonical(ignored.result).includes(TOKEN));
});

test("a prior valid header remains in the contradiction ledger after its candidate becomes unavailable", async t => {
  const f = await run(t, { hook: call => {
    if (call.index === 0 && call.method === "eth_getBlockByHash") return rpcError(401, -32000, TOKEN);
    if (call.index === 1 && call.method === "eth_getBlockByNumber" && call.params[0] === Q(call.range.fromBlock)) call.result.stateRoot = H(777);
    return { result: call.result };
  } });
  assert.equal(f.result.report.status, "CAPTURE-FAILED"); assert.equal(f.result.report.reason, "consensus-mismatch");
  assert.equal(f.calls.filter(call => call.method === "eth_getLogs").length, 0);
  assert.equal(f.result.report.transportDiagnostics.find(event => event.httpStatus === 401).code, "provider-http-failure");
  assert.ok(!canonical(f.result).includes(TOKEN));
});

test("transaction-list disagreement or malformed headers terminate before any log probes", async t => {
  for (const mode of ["list", "schema"]) {
    const f = await run(t, { hook: call => {
      if (call.index === 2 && call.method === "eth_getBlockByNumber") {
        if (mode === "list") call.result.transactions = [H(888)];
        else call.result.timestamp = TOKEN;
      }
      return { result: call.result };
    } });
    assert.equal(f.result.report.status, "CAPTURE-FAILED");
    assert.equal(f.calls.filter(call => call.method === "eth_getLogs").length, 0);
    assert.ok(!canonical(f.result).includes(TOKEN));
  }
});

test("log data disagreements across providers or overlapping parent/child probes invalidate all capabilities", async t => {
  for (const mode of ["provider", "overlap"]) {
    const f = await run(t, { hook: call => {
      if (call.method === "eth_getLogs") {
        if (mode === "provider" && call.index === 1) return { result: [call.log(call.range.fromBlock)] };
        if (mode === "overlap" && call.params[0].fromBlock === call.params[0].toBlock) return { result: [call.log(call.range.fromBlock)] };
      }
      return { result: call.result };
    } });
    assert.equal(f.result.report.status, "CAPTURE-FAILED"); assert.equal(f.result.report.reason, "consensus-mismatch");
    assert.ok(f.result.report.capabilities.probes.every(probe => probe.status === "unknown"));
    assert.ok(!canonical(f.result.report.capabilities).includes("eventCount"));
  }
});

test("matched nonempty queries publish only corroborated counts/hashes, never event rows", async t => {
  const start = D1_RANGES[1].fromBlock;
  const f = await run(t, { events: [start, start + 10, start + 1000] });
  assert.equal(f.result.report.status, "DIAGNOSTIC-COMPLETE");
  assert.deepEqual(f.result.report.capabilities.probes.map(probe => probe.eventCount), [1, 2, 3, 2]);
  const full = f.result.report.capabilities.probes[2];
  assert.equal(full.contentSha256, sha256(canonical(normalizeLogs([f.log(start), f.log(start + 10), f.log(start + 1000)]))));
  assert.equal(full.nonemptyExercised, true);
  assert.ok(!canonical(f.result.report).includes("transactionHash"));
});

test("HTTP auth/rate/server and unknown or unsupported errors retire immediately without later probes", async t => {
  for (const [status, code, message] of [[401, -32000, "unauthorized"], [403, -32000, "forbidden"], [429, -32005, "rate limited"], [500, -32000, "server unavailable"], [400, -32005, "unknown failure"], [200, -32601, "method not found"], [200, -32602, "server timeout"], [200, -32005, "block range is too large; server unavailable"],
    ...[401, 403, 429, 500].map(status => [status, -32602, "block range is too large"]), [200, -32602, "block range is too large; rate limited"]]) {
    const f = await run(t, { hook: call => call.index === 0 && call.method === "eth_getLogs" ? rpcError(status, code, `${message} ${TOKEN}`) : { result: call.result } });
    assert.equal(f.calls.filter(call => call.index === 0 && call.method === "eth_getLogs").length, 1);
    const firstLog = f.calls.findIndex(call => call.index === 0 && call.method === "eth_getLogs");
    assert.ok(f.calls.slice(firstLog + 1).every(call => call.index !== 0));
    assert.equal(f.result.report.status, "DIAGNOSTIC-COMPLETE");
    assert.equal(f.result.report.observations[0].retired, true);
    assert.ok(!canonical(f.result).includes(TOKEN));
  }
});

test("arbitrary -32602 messages retire the candidate on HTTP 200 and 400 without leaking sentinel data", async t => {
  for (const status of [200, 400]) {
    const f = await run(t, { hook: call => call.index === 0 && call.method === "eth_getLogs"
      ? { status, error: { code: -32602, message: `unclassified failure ${TOKEN}`, data: { [TOKEN]: TOKEN } } }
      : { result: call.result } });
    const firstLog = f.calls.findIndex(call => call.index === 0 && call.method === "eth_getLogs");
    assert.ok(firstLog >= 0); assert.ok(f.calls.slice(firstLog + 1).every(call => call.index !== 0));
    assert.equal(f.result.report.observations[0].retired, true);
    assert.deepEqual(f.result.report.observations[0].probes.map(probe => probe.status), ["unavailable", "not-tested", "not-tested", "not-tested"]);
    const event = f.result.report.transportDiagnostics.find(event => event.observationId === "obs-01" && event.method === "eth_getLogs");
    assert.equal(event.rpcErrorCode, -32602); assert.equal(event.restriction, "unknown"); assert.equal(event.httpStatus, status);
    assert.equal(event.code, status === 200 ? "provider-rpc-failure" : "provider-http-failure");
    assert.equal(event.phase, "one-block-array"); assert.equal(event.probeId, "one-block-array");
    assert.equal(f.result.report.status, "DIAGNOSTIC-COMPLETE"); assert.ok(!canonical(f.result).includes(TOKEN));
  }
});

test("range wording with a mismatched error envelope cannot permit continued probes", async t => {
  for (const status of [200, 400]) {
    const f = await run(t, { hook: call => call.index === 0 && call.method === "eth_getLogs"
      ? new Response(JSON.stringify({ jsonrpc: "2.0", id: call.requestId + 1, error: { code: -32005, message: `block range is too large ${TOKEN}` } }), { status })
      : { result: call.result } });
    assert.equal(f.calls.filter(call => call.index === 0 && call.method === "eth_getLogs").length, 1);
    const event = f.result.report.transportDiagnostics.find(event => event.observationId === "obs-01" && event.method === "eth_getLogs");
    assert.equal(event.rpcErrorCode, null); assert.equal(event.restriction, "unknown");
    assert.equal(event.probeId, "one-block-array"); assert.ok(!canonical(f.result).includes(TOKEN));
  }
});

test("request body timeout preserves status, drains, retires that candidate and never retries", { timeout: 3000 }, async t => {
  let activeBodies = 0;
  const f = await run(t, { limits: { requestTimeoutMs: 25 }, hook: call => {
    if (call.index === 0 && call.method === "eth_getLogs") {
      const body = new ReadableStream({ start(controller) {
        activeBodies++;
        call.signal.addEventListener("abort", () => { activeBodies--; controller.error(new Error(TOKEN)); }, { once: true });
      } });
      return new Response(body, { status: 200 });
    }
    return { result: call.result };
  } });
  assert.equal(activeBodies, 0); assert.equal(f.result.report.status, "DIAGNOSTIC-COMPLETE");
  assert.equal(f.calls.filter(call => call.index === 0 && call.method === "eth_getLogs").length, 1);
  const event = f.result.report.transportDiagnostics.find(event => event.code === "request-timeout");
  assert.equal(event.httpStatus, 200); assert.equal(event.phase, "one-block-array"); assert.equal(event.probeId, "one-block-array");
  assert.equal(f.result.report.observations[0].reason, "request-timeout");
  assert.ok(!canonical(f.result).includes(TOKEN));
  assert.ok(fs.existsSync(path.join(f.out, "diagnostics.json")));
});

test("global deadline overrides a candidate failure without another candidate request", async t => {
  const f = await run(t, { limits: { totalTimeoutMs: 1000 }, hook: call => {
    call.setNow(START + 1000);
    return rpcError(403, -32000, TOKEN);
  } });
  assert.equal(f.calls.length, 1); assert.equal(f.result.report.status, "LIMIT-REACHED");
  assert.equal(f.result.report.reason, "total-time-budget-exhausted");
  assert.ok(fs.existsSync(path.join(f.out, "diagnostics.json")));
});

test("explicit full-span restriction permits only remaining declared probes, not retries or subdivision", async t => {
  for (const [status, code] of [[200, -32005], [400, -32005], [200, -32602], [400, -32602]]) {
    const f = await run(t, { hook: call => {
      if (call.index < 2 && call.method === "eth_getLogs" && call.params[0].toBlock === Q(call.range.toBlock)) return rpcError(status, code, `block range is too large ${TOKEN}`);
      return { result: call.result };
    } });
    assert.equal(f.result.report.status, "ACCESS-BLOCKED");
    assert.deepEqual(f.result.report.capabilities.probes.map(probe => probe.status), ["accepted", "accepted", "unknown", "accepted"]);
    assert.equal(f.result.report.capabilities.probes[2].eventCount, undefined);
    for (let index = 0; index < 3; index++) {
      const sent = f.calls.filter(call => call.index === index && call.method === "eth_getLogs");
      assert.equal(sent.length, 4); assert.equal(new Set(sent.map(call => canonical(call.params))).size, 4);
    }
    const failures = f.result.report.transportDiagnostics.filter(event => event.outcome === "failed");
    assert.equal(failures.length, 2);
    assert.ok(failures.every(event => event.restriction === "log-range" && event.code === (status === 200 ? "provider-log-range-restricted" : "provider-http-failure")));
  }
});

test("generic invalid parameters retire candidates instead of trying the later scalar shape", async t => {
  const f = await run(t, { hook: call => call.method === "eth_getLogs" && Array.isArray(call.params[0].address) ? rpcError(400, -32602, "invalid params: expected an address string") : { result: call.result } });
  assert.equal(f.result.report.status, "ACCESS-BLOCKED");
  assert.deepEqual(f.result.report.capabilities.probes.map(probe => probe.status), ["unknown", "unknown", "unknown", "unknown"]);
  assert.equal(f.result.report.budget.logRequests, 3);
  assert.ok(f.result.report.observations.every(obs => obs.retired && obs.probes.slice(1).every(probe => probe.status === "not-tested")));
  assert.ok(f.calls.filter(call => call.method === "eth_getLogs").every(call => Array.isArray(call.params[0].address)));
  assert.equal(f.result.report.capabilities.probes[3].eventCount, undefined);
});

test("single-responder log counts and hashes are never published", async t => {
  const f = await run(t, { events: [D1_RANGES[1].fromBlock], hook: call => call.index > 0 && call.method === "eth_getLogs" ? rpcError(403, -32000, TOKEN) : { result: call.result } });
  assert.equal(f.result.report.status, "ACCESS-BLOCKED");
  assert.ok(f.result.report.capabilities.probes.every(probe => probe.status === "unknown" && !Object.hasOwn(probe, "eventCount") && !Object.hasOwn(probe, "contentSha256")));
});

test("log taint, endpoint block-hash mismatch and canonical recheck drift terminate without repair", async t => {
  for (const mode of ["removed", "hash", "drift"]) {
    let sawLog = false;
    const f = await run(t, { hook: call => {
      if (call.method === "eth_getLogs") {
        sawLog = true; const log = call.log(call.range.fromBlock);
        if (mode === "removed") log.removed = true;
        if (mode === "hash") log.blockHash = H(12345);
        return { result: [log] };
      }
      if (mode === "drift" && sawLog && call.method === "eth_getBlockByNumber") call.result.stateRoot = H(999);
      return { result: call.result };
    } });
    assert.equal(f.result.report.status, "CAPTURE-FAILED");
    assert.equal(f.result.report.budget.logRequests, 1);
    assert.ok(f.result.report.capabilities.probes.every(probe => probe.status === "unknown"));
  }
});

test("global request/log/byte caps terminate and persist only bounded partial diagnostics", async t => {
  for (const limits of [{ requests: 7 }, { logRequests: 1 }, { totalResponseBytes: 128 }]) {
    const f = await run(t, { limits });
    assert.equal(f.result.report.status, "LIMIT-REACHED");
    assert.ok(f.result.report.budget.requests <= (limits.requests || 200));
    assert.ok(f.result.report.budget.logRequests <= (limits.logRequests || 40));
    assert.ok(f.result.report.budget.bytes <= (limits.totalResponseBytes || 64 * 1024 * 1024));
    assert.ok(fs.existsSync(path.join(f.out, "diagnostics.json")));
  }
  assert.equal(D1_LIMITS.traceRequestCap, 0); assert.equal(D1_LIMITS.concurrency, 1); assert.equal(D1_LIMITS.spacingMs, 1000);
});

test("expiry and existing output prevent inventory access; expiration before publication prevents writing", async t => {
  const expired = fixture(t); expired.setNow(Date.parse(EXPIRES_AT));
  await assert.rejects(runDiagnostics(expired.options), /session-expired/); assert.equal(expired.loads(), 0);
  const existing = fixture(t); fs.mkdirSync(existing.out);
  await assert.rejects(runDiagnostics(existing.options), /output-unavailable/); assert.equal(existing.loads(), 0);
  const late = fixture(t, { hook: call => { call.setNow(Date.parse(EXPIRES_AT)); return { result: call.result }; } });
  await assert.rejects(runDiagnostics(late.options), /session-expired/);
  assert.equal(late.calls.length, 1); assert.equal(fs.existsSync(path.join(late.out, "diagnostics.json")), false);
});

test("CLI accepts only the diagnostic scope and prints safe capture status/counts", async t => {
  for (const arg of ["--rpc=x", "--inventory=x", "--trace", "--chain=10", "--qualify"]) assert.throws(() => parseArgs(["--diagnose", "--chain=1", "--out=x", arg]), /invalid-options/);
  const f = fixture(t), printed = [];
  const status = await main(["--diagnose", "--chain=1", `--out=${f.out}`], { runDiagnostics: () => runDiagnostics(f.options), print: line => printed.push(line) });
  assert.equal(status, 0);
  const summary = JSON.parse(printed[0]); assert.equal(summary.status, "DIAGNOSTIC-COMPLETE"); assert.equal(summary.counts.requests, 54);
  assert.ok(!/https:|publicnode|drpc|1rpc|eventCount|transactionHash/.test(printed[0]));
  const errors = [];
  await main(["--diagnose", "--chain=1", "--out=x"], { runDiagnostics: () => { throw new Error(TOKEN); }, print: line => errors.push(line) });
  assert.deepEqual(errors.map(JSON.parse), [{ status: "CAPTURE-FAILED", reason: "capture-failed" }]);
});

test("D2 completes full basic and ordinary-receipt pools before logs using only explicit adapter Origins", async t => {
  const f = await run(t, { authorizedBackoff: true, getOrigin: value => value.includes("alchemy") ? "https://owned-origin.invalid" : null });
  const { report } = f.result;
  assert.equal(f.loads(), 1); assert.equal(f.disposals(), 1);
  assert.equal(report.schema, "strategy-study-d2-v1"); assert.equal(report.mode, "authorized-backoff");
  assert.equal(report.ownerAuthorization, "user-confirmed"); assert.equal(report.backoffEnabled, true); assert.equal(report.publicKeylessOnly, false);
  assert.equal(report.status, "DIAGNOSTIC-COMPLETE"); assert.equal(report.censusComplete, false); assert.equal(report.profitKnown, false);
  const firstTx = f.calls.findIndex(call => call.method === "eth_getTransactionByHash"), firstLog = f.calls.findIndex(call => call.method === "eth_getLogs");
  assert.equal(firstTx, 18); assert.equal(firstLog, 30);
  for (let index = 0; index < 3; index++) {
    assert.equal(f.calls.slice(0, firstTx).filter(call => call.index === index).length, 6);
    assert.equal(f.calls.slice(firstTx, firstLog).filter(call => call.index === index).length, 4);
  }
  assert.equal(report.capabilities.transaction.status, "accepted"); assert.equal(report.capabilities.receipt.status, "accepted");
  assert.equal(report.fixtureReceiptBinding, true); assert.equal(report.receiptBinding, false);
  assert.equal(report.commonPairStatus, "accepted"); assert.equal(report.commonCapabilityPairs.length, 3);
  assert.equal(report.arrayCapabilityPairs.shortArray.status, "accepted"); assert.equal(report.arrayCapabilityPairs.fullArray.status, "accepted");
  assert.equal(report.arrayCapabilityPairs.fullArray.toBlock, String(f.range.toBlock));
  assert.deepEqual(report.limits, D2_LIMITS); assert.equal(report.budget.requests, 66); assert.equal(report.budget.logRequests, 12); assert.equal(report.budget.traceRequests, 0);
  assert.equal(report.transportDiagnostics.length, 66); assert.ok(f.calls.every(call => D2_METHODS.includes(call.method)));
  assert.ok(report.transportDiagnostics.every(event => D2_PHASES.includes(event.phase) && event.attempt === 1));
  assert.ok(report.transportDiagnostics.filter(event => event.phase.startsWith("fixture-")).every(event => event.fixtureIndex === 0 && event.probeId === null));
  assert.ok(report.transportDiagnostics.filter(event => event.method === "eth_getLogs").every(event => event.phase === event.probeId && event.fixtureIndex === null));
  assert.deepEqual(report.backoff.beforeClose, report.backoff.afterClose); assert.equal(report.backoff.afterClose.retries, 0);
  assert.equal(report.backoff.afterClose.activeOperations, 0); assert.equal(report.backoff.afterClose.pendingRuns, 0);
  const encoded = fs.readFileSync(path.join(f.out, "diagnostics.json"), "utf8");
  assert.ok(!/D1_RESPONSE_SECRET|alchemy|infura|publicnode|owned-origin|https:/.test(encoded));
  assert.equal(f.result.sha256, sha256(canonical({ captureId: f.result.captureId, report })));
});

test("D2 CLI is explicit and default D1 never invokes authorized loading or backoff", async t => {
  assert.deepEqual(parseArgs(["--diagnose", "--chain=1", "--out=x"]), { chainId: 1, out: "x" });
  assert.deepEqual(parseArgs(["--diagnose", "--authorized-backoff", "--chain=8453", "--out=x"]), { chainId: 8453, out: "x", authorizedBackoff: true });
  assert.throws(() => parseArgs(["--diagnose", "--authorized-backoff", "--authorized-backoff", "--chain=1", "--out=x"]), /invalid-options/);
  for (const arg of ["--trace", "--authorized-backoff=false", "--rpc=x", "--inventory=x", "--method=eth_call"]) assert.throws(() => parseArgs(["--diagnose", "--authorized-backoff", "--chain=1", "--out=x", arg]), /invalid-options/);
  const d1 = fixture(t);
  const result = await runDiagnostics({ ...d1.options, loadAuthorizedCandidates: () => { assert.fail("D1 must not load authorized inventory"); }, backoffRandom: () => { assert.fail("D1 must not activate backoff"); } });
  assert.equal(result.report.schema, "strategy-study-d1-v1"); assert.equal(result.report.mode, "public");
  assert.equal(result.report.budget.requests, 54); assert.ok(result.report.transportDiagnostics.every(event => event.attempt === undefined));
  const f = fixture(t, { authorizedBackoff: true }), printed = [];
  const exit = await main(["--diagnose", "--authorized-backoff", "--chain=1", `--out=${f.out}`], {
    runDiagnostics: options => { assert.equal(options.authorizedBackoff, true); return runDiagnostics(f.options); }, print: line => printed.push(line),
  });
  assert.equal(exit, 0); assert.equal(JSON.parse(printed[0]).counts.requests, 66); assert.ok(!printed[0].includes(TOKEN));
});

test("D2 wrong-chain candidates stop before target reads and same-family-only pools cannot derive a fixture", async t => {
  const wrong = await run(t, { authorizedBackoff: true, hook: call => ({ result: call.index === 0 && call.method === "eth_chainId" ? "0x2105" : call.result }) });
  assert.deepEqual(wrong.calls.filter(call => call.index === 0).map(call => call.method), ["eth_chainId"]);
  assert.equal(wrong.result.report.status, "DIAGNOSTIC-COMPLETE"); assert.equal(wrong.result.report.observations[0].reason, "wrong-chain");
  const same = await run(t, { authorizedBackoff: true, routes: [`https://eth.alchemy.com/a-${TOKEN}`, `https://eth.alchemy.com/b-${TOKEN}`] });
  assert.equal(same.result.report.status, "ACCESS-BLOCKED"); assert.equal(same.calls.length, 12);
  assert.equal(same.result.report.capabilities.transaction.status, "unknown"); assert.equal(same.result.report.capabilities.receipt.status, "unknown");
  assert.deepEqual(same.result.report.commonCapabilityPairs, []);
});

test("D2 transaction and receipt contradictions invalidate every material capability, including prior partial evidence", async t => {
  for (const mode of ["transaction", "receipt", "partial-transaction", "partial-receipt"]) {
    let firstReceipt = false;
    const f = await run(t, { authorizedBackoff: true, hook: call => {
      if (mode === "partial-transaction" && call.index === 0 && call.method === "eth_getTransactionReceipt") return rpcError(403, -32000, TOKEN);
      if (mode === "partial-receipt" && call.index === 0) {
        if (call.method === "eth_getTransactionReceipt") firstReceipt = true;
        else if (firstReceipt && call.method === "eth_getBlockByNumber") return rpcError(403, -32000, TOKEN);
      }
      if (call.index === (mode.startsWith("partial-") ? 1 : 2)) {
        if (mode.endsWith("transaction") && call.method === "eth_getTransactionByHash") call.result.nonce = "0x2";
        if (mode.endsWith("receipt") && call.method === "eth_getTransactionReceipt") call.result.gasUsed = "0x5209";
      }
      return { result: call.result };
    } });
    assert.equal(f.result.report.status, "CAPTURE-FAILED"); assert.equal(f.result.report.reason, "consensus-mismatch");
    for (const key of ["headerByNumber", "headerByHash", "transaction", "receipt"]) assert.deepEqual(f.result.report.capabilities[key], { status: "unknown" });
    assert.equal(f.calls.filter(call => call.method === "eth_getLogs").length, 0); assert.deepEqual(f.result.report.commonCapabilityPairs, []);
    assert.ok(!canonical(f.result).includes(TOKEN)); assert.equal(f.disposals(), 1);
  }
});

test("D2 malformed or incorrectly bound transaction/receipt evidence is terminal", async t => {
  for (const mode of ["transaction-schema", "transaction-chain", "receipt-status", "receipt-binding"]) {
    const f = await run(t, { authorizedBackoff: true, hook: call => {
      if (call.index === 0 && call.method === "eth_getTransactionByHash") {
        if (mode === "transaction-schema") call.result.input = TOKEN;
        if (mode === "transaction-chain") call.result.chainId = "0xa";
      }
      if (call.index === 0 && call.method === "eth_getTransactionReceipt") {
        if (mode === "receipt-status") call.result.status = "0x2";
        if (mode === "receipt-binding") call.result.transactionHash = H(123);
      }
      return { result: call.result };
    } });
    assert.equal(f.result.report.status, "CAPTURE-FAILED"); assert.equal(f.result.report.capabilities.receipt.status, "unknown");
    assert.equal(f.result.report.budget.logRequests, 0); assert.ok(!canonical(f.result).includes(TOKEN));
  }
});

test("D2 skips only paired system deposits in the first eight hashes and accepts an ordinary status-zero fixture", async t => {
  const f = await run(t, { authorizedBackoff: true, chainId: 8453, fixtureTransactions: 2, deposits: 1, receiptStatus: "0x0" });
  assert.equal(f.result.report.status, "DIAGNOSTIC-COMPLETE");
  assert.equal(f.result.report.capabilities.transaction.transactionHash, f.txHash(f.range.fromBlock, 1));
  assert.equal(f.calls.filter(call => call.method === "eth_getTransactionByHash").length, 6);
  assert.deepEqual([...new Set(f.result.report.transportDiagnostics.filter(event => event.phase === "fixture-transaction").map(event => event.fixtureIndex))], [0, 1]);
  const bounded = await run(t, { authorizedBackoff: true, fixtureTransactions: 9, deposits: 8 });
  assert.equal(bounded.result.report.reason, "ordinary-transaction-unavailable"); assert.equal(bounded.result.report.budget.logRequests, 0);
  assert.equal(bounded.calls.filter(call => call.method === "eth_getTransactionByHash").length, 24);
  assert.ok(bounded.calls.every(call => call.params[0] !== bounded.txHash(bounded.range.fromBlock, 8)));
  assert.equal(bounded.result.report.capabilities.transaction.status, "unknown");
});

test("D2 unavailable first fixture cannot be replaced by another hash or publish single-provider receipt facts", async t => {
  const f = await run(t, { authorizedBackoff: true, fixtureTransactions: 2, hook: call => call.index > 0 && call.method === "eth_getTransactionReceipt" ? rpcError(403, -32000, TOKEN) : { result: call.result } });
  assert.equal(f.result.report.status, "ACCESS-BLOCKED"); assert.equal(f.result.report.reason, "independent-pair-unavailable");
  assert.equal(f.result.report.capabilities.transaction.status, "unknown"); assert.equal(f.result.report.capabilities.receipt.status, "unknown");
  assert.equal(f.result.report.budget.logRequests, 0);
  assert.ok(f.calls.filter(call => call.method === "eth_getTransactionByHash").every(call => call.params[0] === f.txHash(f.range.fromBlock)));
  const material = canonical(f.result.report.capabilities);
  assert.ok(!material.includes("evidenceSha256")); assert.ok(!material.includes(f.txHash(f.range.fromBlock)));
});

test("D2 HTTP 429 retries are counted physical attempts with identical phase/probe labels and pinned requests", async t => {
  let attempts = 0;
  const f = await run(t, { authorizedBackoff: true, hook: call => {
    if (call.index === 0 && call.method === "eth_chainId" && ++attempts === 1) return { ...rpcError(429, -32005, TOKEN), headers: { "retry-after": "2" } };
    return { result: call.result };
  } });
  assert.equal(f.result.report.status, "DIAGNOSTIC-COMPLETE"); assert.equal(f.result.report.budget.requests, 67);
  const diagnostics = f.result.report.transportDiagnostics.slice(0, 2);
  assert.deepEqual(diagnostics.map(event => [event.observationId, event.phase, event.probeId, event.attempt, event.httpStatus]),
    [["obs-01", "chain-id", null, 1, 429], ["obs-01", "chain-id", null, 2, 200]]);
  assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.result.report.backoff.afterClose.retries, 1);
  assert.ok(!canonical(f.result).includes(TOKEN));
});

test("D2 circuits stop other credentials in that family without replacement RPCs, while other declared candidates can qualify", async t => {
  const f = await run(t, { authorizedBackoff: true, routes: [`https://eth.alchemy.com/a-${TOKEN}`, `https://eth.alchemy.com/b-${TOKEN}`, `https://eth.infura.io/a-${TOKEN}`, "https://ethereum.publicnode.com"],
    hook: call => call.index === 0 ? { ...rpcError(429, -32005, TOKEN), headers: { "retry-after": "1" } } : { result: call.result },
  });
  assert.equal(f.calls.filter(call => call.index === 0).length, 3); assert.equal(f.calls.filter(call => call.index === 1).length, 0);
  assert.equal(f.result.report.observations[1].reason, "provider-circuit-open");
  assert.equal(f.result.report.status, "DIAGNOSTIC-COMPLETE"); assert.equal(f.result.report.backoff.afterClose.retries, 2);
  assert.deepEqual(f.result.report.commonCapabilityPairs, [["obs-03", "obs-04"]]);
});

test("D2 global caps and logical deadlines are terminal rather than candidate availability", async t => {
  const capped = await run(t, { authorizedBackoff: true, limits: { requests: 1 }, hook: () => rpcError(429, -32005, TOKEN) });
  assert.equal(capped.result.report.status, "LIMIT-REACHED"); assert.equal(capped.result.report.reason, "request-budget-exhausted"); assert.equal(capped.calls.length, 1);
  const deadline = await run(t, { authorizedBackoff: true, hook: call => { call.setNow(START + 60000); return { result: call.result }; } });
  assert.equal(deadline.result.report.status, "LIMIT-REACHED"); assert.equal(deadline.result.report.reason, "backoff-deadline-exceeded"); assert.equal(deadline.calls.length, 1);
  for (const limits of [{ candidatePool: 17 }, { requests: 501 }, { logRequests: 81 }, { traceRequestCap: 1 }, { totalTimeoutMs: 1200001 }, { spacingMs: 999 }]) {
    const f = fixture(t, { authorizedBackoff: true, limits });
    await assert.rejects(runDiagnostics(f.options), /invalid-options/); assert.equal(f.loads(), 0);
  }
  assert.ok(Object.isFrozen(D2_LIMITS)); assert.equal(D2_LIMITS.requestTimeoutMs, 20000); assert.equal(D2_LIMITS.responseBytes, 8 * 1024 * 1024);
  assert.equal(D2_LIMITS.totalResponseBytes, 128 * 1024 * 1024); assert.equal(D2_LIMITS.concurrency, 1);
  assert.equal(D2_METHODS.length, 6); assert.ok(!D2_METHODS.some(method => /trace|send|call|storage|code/i.test(method)));
});

test("D2 disjoint per-query pairs never become a common fixed capability pair", async t => {
  const f = await run(t, { authorizedBackoff: true, routes: ["https://eth.alchemy.com/synthetic", "https://eth.infura.io/synthetic", "https://ethereum.publicnode.com", "https://eth.drpc.org"], hook: call => {
    if (call.method === "eth_getLogs" && Array.isArray(call.params[0].address)) {
      const span = BigInt(call.params[0].toBlock) - BigInt(call.params[0].fromBlock) + 1n;
      if ((span === 256n && call.index >= 2) || (span === 4096n && call.index < 2)) return rpcError(400, -32005, "block range is too large");
    }
    return { result: call.result };
  } });
  const { report } = f.result;
  assert.equal(report.allProbeCapabilitiesAccepted, true); assert.ok(report.capabilities.probes.every(probe => probe.status === "accepted"));
  assert.equal(report.status, "ACCESS-BLOCKED"); assert.equal(report.commonPairStatus, "unknown"); assert.deepEqual(report.commonCapabilityPairs, []);
  assert.deepEqual(report.arrayCapabilityPairs.shortArray.pairs, [["obs-01", "obs-02"]]);
  assert.deepEqual(report.arrayCapabilityPairs.fullArray.pairs, [["obs-03", "obs-04"]]);
});

test("D2 optional scalar capability is separate from common array-pair evidence and unpaired event facts stay absent", async t => {
  const scalar = await run(t, { authorizedBackoff: true, hook: call => call.method === "eth_getLogs" && !Array.isArray(call.params[0].address) ? rpcError(400, -32602, TOKEN) : { result: call.result } });
  assert.equal(scalar.result.report.commonPairStatus, "accepted"); assert.equal(scalar.result.report.allProbeCapabilitiesAccepted, false);
  assert.equal(scalar.result.report.capabilities.probes[3].status, "unknown"); assert.equal(scalar.result.report.status, "ACCESS-BLOCKED");
  const unpaired = await run(t, { authorizedBackoff: true, events: [D1_RANGES[1].fromBlock], hook: call => call.method === "eth_getLogs" && call.index > 0 ? rpcError(403, -32000, TOKEN) : { result: call.result } });
  assert.equal(unpaired.result.report.capabilities.receipt.status, "accepted");
  assert.ok(unpaired.result.report.capabilities.probes.every(probe => probe.status === "unknown" && !Object.hasOwn(probe, "eventCount") && !Object.hasOwn(probe, "contentSha256")));
  assert.deepEqual(unpaired.result.report.commonCapabilityPairs, []);
});

test("D2 expiry/output reservation precede loading, unsafe adapters fail before RPC, and disposal follows runtime drain", async t => {
  const expired = fixture(t, { authorizedBackoff: true }); expired.setNow(Date.parse(EXPIRES_AT));
  await assert.rejects(runDiagnostics(expired.options), /session-expired/); assert.equal(expired.loads(), 0);
  const exists = fixture(t, { authorizedBackoff: true }); fs.mkdirSync(exists.out);
  await assert.rejects(runDiagnostics(exists.options), /output-unavailable/); assert.equal(exists.loads(), 0);
  for (const route of ["https://unknown.invalid/key", "https://user@eth.alchemy.com/key", "https://eth.alchemy.com/key#fragment", "http://eth.alchemy.com/key"]) {
    const f = await run(t, { authorizedBackoff: true, routes: [route] });
    assert.equal(f.result.report.status, "CAPTURE-FAILED"); assert.equal(f.calls.length, 0); assert.equal(f.disposals(), 1);
  }
  const captureModule = require("../strategy-study/capture"), filename = require.resolve("../strategy-study/diagnose-cli");
  const original = captureModule.createRuntime, cached = require.cache[filename], order = [];
  captureModule.createRuntime = options => {
    const runtime = original(options);
    return Object.freeze({ ...runtime, close: async () => { await runtime.close(); assert.deepEqual(runtime.lifecycle(), { closed: true, pending: 0 }); order.push("closed"); } });
  };
  try {
    delete require.cache[filename];
    const instrumented = require("../strategy-study/diagnose-cli");
    const f = fixture(t, { authorizedBackoff: true, onDispose: () => order.push("disposed") });
    await instrumented.runDiagnostics(f.options);
    assert.deepEqual(order, ["closed", "disposed"]);
  } finally { captureModule.createRuntime = original; require.cache[filename] = cached; }
});

test("integrity remains latched when a later request or time budget determines the terminal status", async t => {
  const d1 = await run(t, { limits: { requests: 43 }, hook: call => ({ result: call.index === 2 && call.method === "eth_getLogs" ? null : call.result }) });
  assert.equal(d1.result.report.status, "LIMIT-REACHED"); assert.equal(d1.result.report.reason, "request-budget-exhausted");
  assert.equal(d1.result.report.integrityFailure.code, "tainted-log-response");
  assert.equal(d1.result.report.capabilities.headerByNumber.status, "unknown");
  assert.ok(d1.result.report.capabilities.probes.every(probe => probe.status === "unknown"));

  const captureModule = require("../strategy-study/capture"), filename = require.resolve("../strategy-study/diagnose-cli");
  const original = captureModule.normalizeLogs, cached = require.cache[filename];
  const f = fixture(t, { authorizedBackoff: true, hook: call => ({ result: call.index === 2 && call.method === "eth_getLogs" ? null : call.result }) });
  captureModule.normalizeLogs = (...args) => {
    try { return original(...args); }
    catch (error) { f.setNow(START + D2_LIMITS.totalTimeoutMs); throw error; }
  };
  try {
    delete require.cache[filename];
    const { report } = await require("../strategy-study/diagnose-cli").runDiagnostics(f.options);
    assert.equal(report.status, "LIMIT-REACHED"); assert.equal(report.reason, "total-time-budget-exhausted");
    assert.deepEqual(report.integrityFailure, { observationId: "obs-03", phase: "one-block-array", code: "tainted-log-response" });
    for (const key of ["headerByNumber", "headerByHash", "transaction", "receipt"]) assert.deepEqual(report.capabilities[key], { status: "unknown" });
    assert.ok(report.capabilities.probes.every(probe => probe.status === "unknown"));
    assert.equal(report.fixtureReceiptBinding, false); assert.equal(report.allProbeCapabilitiesAccepted, false);
    assert.equal(report.commonPairStatus, "unknown"); assert.deepEqual(report.commonCapabilityPairs, []);
    assert.deepEqual(report.arrayCapabilityPairs, { shortArray: { status: "unknown", pairs: [] }, fullArray: { status: "unknown", pairs: [] } });
    assert.equal(f.disposals(), 1);
  } finally { captureModule.normalizeLogs = original; require.cache[filename] = cached; }
});
