#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const fs = require("node:fs"), path = require("node:path");
const r = require("./run-aave-ethereum-emode-47-48-r10-authority.js");
const r9 = require("./run-aave-ethereum-emode-47-48-r9-authority.js"), r4 = require("./run-aave-ethereum-emode-47-48-r4.js");
const pf = require("./lib/common-finalized-rpc-preflight.js");
const candidates = pf.REVIEWED_OPERATOR_FAMILY_IDS.slice(0, 8).map((operatorFamily, n) => ({ operatorFamily,
  handle: { url: new URL(`https://fixture-${n}.invalid/`) } }));
const pair = candidates.slice(0, 2), context = r.specs.find(s => s.key === "agentContext");
const header = { number: `0x${r.PIN.number.toString(16)}`, hash: r.PIN.hash, parentHash: r.PIN.parentHash,
  stateRoot: r.PIN.stateRoot, timestamp: `0x${BigInt(r.PIN.timestamp).toString(16)}` };
const values = { hubOwner: "0x1111111111111111111111111111111111111111", agentAdmin: "0x2cfe3ec4d5a6811f4b8067f0de7e47dfa938aa30",
  agentContext: `0x${"0".repeat(24)}${r.A.engine.slice(2)}`, aclAdmin: "0x2222222222222222222222222222222222222222",
  agentRiskAdmin: true, riskOracleOwner: "0x3333333333333333333333333333333333333333", forwarderAuthorized: false, routerAuthorized: true };
function result(body) {
  if (body.method === "eth_chainId") return "0x1";
  if (body.method === "eth_getBlockByNumber") return body.params[0] === "finalized" ? { ...header, number: `0x${(r.PIN.number + 1).toString(16)}` } : header;
  if (body.method === "eth_getStorageAt") return `0x${"0".repeat(24)}${"4".repeat(40)}`;
  const spec = r.specs.find(s => s.target === body.params[0].to && s.data === body.params[0].data);
  assert.ok(spec); return spec.iface.encodeFunctionResult(spec.fn, [values[spec.key]]);
}
function mockRequest(transform = () => ({})) {
  const seen = [];
  const request = (options, callback) => {
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.method, "POST");
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = bytes => {
      const body = JSON.parse(bytes); seen.push(body);
      process.nextTick(() => {
        const patch = transform(body, options, seen.length) || {};
        if (patch.error) { req.emit("error", Error("synthetic transport diagnostic must not escape")); return; }
        const res = new EventEmitter(); res.statusCode = patch.statusCode || 200; callback(res);
        const raw = patch.raw || Buffer.from(JSON.stringify(patch.envelope || { jsonrpc: "2.0", id: body.id,
          result: Object.hasOwn(patch, "result") ? patch.result : result(body) }));
        res.emit("data", raw); res.emit("end");
      });
    };
    return req;
  };
  return { request, seen };
}
async function collect(transform, pool = pair, extra = {}) {
  const mock = mockRequest(transform), transport = r.createTransport(pool, { request: mock.request, ...extra });
  const report = await r.collect({ candidates: pool, transport });
  Object.assign(report, { executionMode: "injected", inventoryReadAttempts: 0, inventoryReads: 0,
    transportRequestAttempts: transport.stats.calls, responseBytes: transport.stats.responseBytes, sourceHashes: {} });
  return { report, mock, transport };
}

test("retained R9 source bundle, commitments and three review defects verify without rebuilding", () => {
  const { review } = r.reviewPrior();
  assert.equal(review.sourceBundle, "PASS"); assert.equal(review.sources, 25); assert.equal(review.runtimeBytes, 21262);
  assert.equal(review.rejectedStage, "hubProxyAdmin"); assert.equal(review.r9ContextDecoderDefect, true);
  assert.equal(review.r9GateValidatorDefect, true); assert.equal(review.network, false);
});
test("R9 real transport reproduces five ledger calls/four attempts and stops before storage or owner reads", async () => {
  const mock = mockRequest((_body, _options, n) => n === 1 ? { error: true } : {});
  const transport = r4.createTransport(pair, { request: mock.request });
  const report = await r9.collect({ candidates: pair, rawCall: transport.call.bind(transport), pf });
  assert.equal(report.code, "REQUEST_FORBIDDEN"); assert.equal(report.callsUsed, 5); assert.equal(transport.stats.calls, 4);
  assert.deepEqual(mock.seen.map(b => b.method), ["eth_chainId", "eth_chainId", "eth_getBlockByNumber", "eth_getBlockByNumber"]);
});
test("R10 handles every frozen read through its actual transport and terminal replay", async () => {
  const { report, mock } = await collect();
  assert.equal(report.status, "CORROBORATED_AUTHORITY_TOPOLOGY"); assert.equal(report.callsUsed, 52);
  assert.equal(mock.seen.filter(b => b.method === "eth_call").length, 32);
  assert.equal(mock.seen.filter(b => b.method === "eth_getStorageAt").length, 4);
  assert.equal(report.observation.agentContext, r.A.engine); assert.equal(r.validate(report, {}), true);
});
test("real 32-byte ABI context is accepted and the erroneous 20-byte fixture rejected", () => {
  const raw = context.iface.encodeFunctionResult(context.fn, [values.agentContext]);
  assert.throws(() => r9.decode(context, raw), /CALL_INVALID/); assert.equal(r.decode(context, raw), r.A.engine);
  assert.throws(() => r.decode(context, context.iface.encodeFunctionResult(context.fn, [r.A.engine])), /CALL_INVALID/);
});
test("qualification can reject a candidate before selecting two state-capable families", async () => {
  const { report } = await collect((_body, _options, n) => n === 1 ? { error: true } : {}, candidates.slice(0, 3));
  assert.deepEqual(report.selectedCandidateOrdinals, [1, 2]); assert.equal(report.callsUsed, 53);
  assert.deepEqual(report.failures, [{ ordinal: 0, phase: "qualification", stage: "chain", code: "RPC_UNAVAILABLE" }]);
  assert.equal(r.validate(report, {}), true);
});
test("unknown or duplicate provider handles fail before any request", async () => {
  for (const pool of [[pair[0], { ...pair[1], operatorFamily: "unreviewed" }], [pair[0], pair[0]]]) {
    const mock = mockRequest(), transport = r.createTransport(pool, { request: mock.request });
    await assert.rejects(r.collect({ candidates: pool, transport }), /INPUT_INVALID/); assert.equal(mock.seen.length, 0);
  }
});
test("two handles with one family cannot corroborate", async () => {
  const pool = [pair[0], { ...pair[1], operatorFamily: pair[0].operatorFamily }];
  const { report } = await collect(undefined, pool); assert.equal(report.status, "INCOMPLETE"); assert.equal(r.validate(report, {}), true);
});
test("disagreement is not ignored in search of a preferred pair", async () => {
  const { report } = await collect((body, _options, n) => body.method === "eth_getStorageAt" && n > 13
    ? { result: `0x${"0".repeat(24)}${"5".repeat(40)}` } : {}, candidates.slice(0, 3));
  assert.equal(report.code, "STATE_DISAGREEMENT"); assert.equal(report.callsUsed, 26); assert.equal(report.observation, null);
});
test("terminal change retracts all topology observations", async () => {
  const { report } = await collect((body, _options, n) => body.method === "eth_getStorageAt" && n > 26
    ? { result: `0x${"0".repeat(24)}${"5".repeat(40)}` } : {});
  assert.equal(report.code, "TERMINAL_RECHECK_FAILED"); assert.equal(report.observation, null); assert.equal(r.validate(report, {}), true);
});
test("wrong chain, historical header and ABI are recorded as stage-specific blockers", async () => {
  const cases = [
    [(body) => body.method === "eth_chainId" ? { result: "0x2" } : {}, "chain", "CHAIN_MISMATCH"],
    [(body) => body.method === "eth_getBlockByNumber" && body.params[0] !== "finalized" ? { result: { ...header, hash: `0x${"0".repeat(64)}` } } : {}, "header", "HISTORICAL_HEADER_MISMATCH"],
    [(body) => body.method === "eth_call" ? { result: "0x" } : {}, "hubOwner", "CALL_INVALID"]
  ];
  for (const [transform, stage, code] of cases) {
    const { report } = await collect(transform); assert.equal(report.status, "INCOMPLETE");
    assert.equal(report.failures[0].stage, stage); assert.equal(report.failures[0].code, code); assert.equal(r.validate(report, {}), true);
  }
});
test("write methods, unknown targets, state overrides, latest and alternative slots cannot reach transport", async () => {
  const mock = mockRequest(), transport = r.createTransport(pair, { request: mock.request }), s = r.specs[0];
  for (const [method, params] of [["eth_sendRawTransaction", ["0x"]], ["eth_getCode", [r.A.hub, r.BLOCK]],
    ["eth_getStorageAt", [r.A.hub, r4.IMPLEMENTATION_SLOT, r.BLOCK]], ["eth_call", [{ to: r.A.hub, data: s.data }, "latest"]],
    ["eth_call", [{ to: r.A.hub, data: s.data }, r.BLOCK, {}]], ["eth_call", [{ to: r.A.pool, data: s.data }, r.BLOCK]]]) {
    await assert.rejects(transport.call(pair[0].handle, method, params), /REQUEST_FORBIDDEN/);
  }
  assert.equal(mock.seen.length, 0);
});
test("redirects, JSON-RPC errors and wrong response IDs are sanitized without retries", async () => {
  for (const transform of [() => ({ statusCode: 302 }), () => ({ envelope: { jsonrpc: "2.0", id: 1, error: { message: "synthetic private diagnostic" } } }),
    body => ({ envelope: { jsonrpc: "2.0", id: body.id + 1, result: "0x1" } })]) {
    const { report, mock } = await collect(transform); assert.equal(mock.seen.length, 2); assert.equal(report.failures[0].code, "RPC_UNAVAILABLE");
    assert.equal(JSON.stringify(report).includes("synthetic private"), false);
  }
});
test("byte and wall exhaustion stop the entire batch", async () => {
  const { report } = await collect(() => ({ raw: Buffer.alloc(r.LIMITS.responseBytes + 1, 32) }));
  assert.equal(report.code, "BYTE_CAP"); assert.equal(report.callsUsed, 1); assert.equal(r.validate(report, {}), true);
  let ticks = 0;
  const wall = await collect(undefined, pair, { monotonic: () => ++ticks === 1 ? 0 : r.LIMITS.wallMs });
  assert.equal(wall.report.code, "WALL_CAP"); assert.equal(wall.mock.seen.length, 0);
});
test("112-call budget is enforced by the transport", async () => {
  const mock = mockRequest(), transport = r.createTransport(pair, { request: mock.request });
  for (let i = 0; i < r.LIMITS.calls; i++) await transport.call(pair[0].handle, "eth_chainId", []);
  await assert.rejects(transport.call(pair[0].handle, "eth_chainId", []), /NETWORK_CALL_CAP/); assert.equal(mock.seen.length, 112);
});
test("strict report validation rejects every promoted gate and malformed evidence accounting", async () => {
  const { report } = await collect();
  for (const key of Object.keys(report.gates)) {
    const changed = structuredClone(report); changed.gates[key] = report.gates[key] === true ? false : true;
    assert.throws(() => r.validate(changed, {}), /OUTPUT_INVALID/);
  }
  for (const mutate of [x => { x.transportRequestAttempts--; }, x => { x.callsUsed = 0; }, x => { x.sourceHashes.fake = "0"; },
    x => { x.extra = true; }, x => { x.observation.hubOwner = "invalid"; }, x => { x.selectedCandidateOrdinals = [0, 0]; },
    x => { x.executionMode = "production"; }]) {
    const changed = structuredClone(report); mutate(changed); assert.throws(() => r.validate(changed, {}), /OUTPUT_INVALID/);
  }
});
test("debug, TLS override and preload environment are blocked", () => {
  for (const key of ["NODE_OPTIONS", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_TLS_REJECT_UNAUTHORIZED", "SSLKEYLOGFILE"])
    assert.throws(() => r.invocationGuard({ [key]: "enabled" }, []), /INVOCATION_INVALID/);
  assert.throws(() => r.invocationGuard({}, ["--inspect"]), /INVOCATION_INVALID/);
  r.invocationGuard({}, []);
});
test("actual transport publication is inventory-free in tests, marker-first and append-only", async () => {
  const root = fs.mkdtempSync("C:/Users/MiPC/AppData/Local/Temp/opencode/emode-r10-");
  const inventory = require("./preflight-all-chain-endpoints-v4.js"), original = inventory.readSource;
  fs.mkdirSync(path.join(root, "reports/raw/fast"), { recursive: true });
  inventory.readSource = () => { throw Error("TEST_MUST_NOT_READ_INVENTORY"); };
  try {
    const mock = mockRequest(() => { assert.equal(fs.existsSync(path.join(root, r.ATTEMPT)), true); return {}; });
    const options = { root, candidates: pair, request: mock.request }, output = await r.runOnce(options);
    assert.equal(output.sha256, r.sha(r.stable(output.report))); assert.equal(output.report.executionMode, "injected");
    assert.equal(output.report.inventoryReads, 0); assert.equal(output.report.transportRequestAttempts, 52);
    const review = r.reviewCapture(root);
    assert.equal(review.artifactCommitmentVerified, true); assert.equal(review.completeAuthorityVerified, false);
    assert.deepEqual(review.priorStateConsistency, { agentAdmin: true, agentContext: true, agentRiskAdmin: true });
    const bytes = fs.readFileSync(path.join(root, r.OUTPUT));
    await assert.rejects(r.runOnce(options), /ATTEMPT_CONSUMED/); assert.deepEqual(fs.readFileSync(path.join(root, r.OUTPUT)), bytes);
    await assert.rejects(r.runOnce({ ...options, root: r.ROOT }), /INPUT_INVALID/);
    await assert.rejects(r.runOnce({ root }), /INPUT_INVALID/);
    await assert.rejects(r.runOnce(), /INVOCATION_INVALID/);
  } finally { inventory.readSource = original; fs.rmSync(root, { recursive: true, force: true }); }
});
