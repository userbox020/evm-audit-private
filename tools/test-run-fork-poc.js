"use strict";

// Offline node:test suite for tools/run-fork-poc.js.
//
// ALL network and Anvil dependencies are injected mocks. This suite makes no
// network requests, starts no Anvil process, and never reads rpc_endpoints.txt.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const poc = require("./run-fork-poc");

test("phase B manual setup/load failure returns initialized caller context without endpoint work", async () => {
  const writes = [];
  const r = await poc.runForkPoc({ chain: "1", block: "123", scenario: "synthetic", outPath: "not-written" }, {
    now: () => Date.parse("2026-10-14T04:00:00.000Z"),
    loadScenario: () => { throw new Error("private setup detail"); },
    readInventory: () => { throw new Error("must not read inventory"); },
    writeEvidence: (_file, data) => { writes.push(data); },
  });
  assert.equal(r.status, "FAIL_CLOSED"); assert.equal(r.callerClass, "MANUAL");
  assert.equal(r.eventContext, null); assert.equal(r.output.eventContext, null);
  assert.equal(writes.length, 1); assert.ok(!JSON.stringify(r).includes("private setup"));
});
test("phase B manual clock/setup throw retains diagnostic context without artifact mutation", async () => {
  let writes = 0;
  const r = await poc.runForkPoc({}, { now: () => { throw new Error("private clock"); }, writeEvidence: () => { ++writes; } });
  assert.equal(r.status, "FAIL_CLOSED"); assert.equal(r.callerClass, "MANUAL"); assert.equal(r.eventContext, null); assert.equal(writes, 0);
});
test("phase B manual artifact failure still returns initialized metadata", async () => {
  const r = await poc.runForkPoc({ chain: "1", block: "123", scenario: "synthetic", outPath: "not-written" }, {
    now: () => Date.parse("2026-10-14T04:00:00.000Z"), loadScenario: () => ({}), writeEvidence: () => { throw new Error("private writer"); },
  });
  assert.equal(r.status, "FAIL_CLOSED"); assert.equal(r.callerClass, "MANUAL"); assert.equal(r.output.callerClass, "MANUAL"); assert.equal(r.eventContext, null);
});

const ADDR_A = "0x00000000000000000000000000000000000000A1";
const ADDR_B = "0x00000000000000000000000000000000000000B2";
const DATA = "0x12345678";
const H = (byte) => `0x${byte.repeat(64)}`;

function mockRpc(overrides = {}) {
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    if (Object.hasOwn(overrides, method)) return typeof overrides[method] === "function" ? overrides[method](params) : overrides[method];
    if (method === "eth_call") return "0x01";
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (method === "eth_getStorageAt") return `0x${"0".repeat(64)}`;
    if (method === "eth_getCode") return "0x6000";
    if (method === "evm_snapshot") return "0x1";
    if (method === "evm_revert") return true;
    if (method === "eth_sendTransaction") return `0x${"ab".repeat(32)}`;
    if (method === "eth_getTransactionReceipt") return { status: "0x1", gasUsed: "0x5208" };
    return true;
  };
  return { calls, call };
}

function mockChild() {
  return { pid: 4242, exitCode: null, signalCode: null, kill() {}, once() {}, removeListener() {} };
}

function harness(overrides = {}) {
  const rpc = overrides.rpc || mockRpc();
  const events = { relayCreated: 0, relayClosed: 0, anvilStarted: 0, anvilStopped: 0, waitReady: 0, anvilArgs: null, relayUpstream: null };
  const deps = {
    loadRpcUrls: () => [],
    resolveUpstream: async () => "https://mock-upstream.invalid",
    transport: async (_url, payload) => {
      if (payload.method === "eth_getBlockByNumber") {
        return { value: { jsonrpc: "2.0", id: payload.id, result: { number: "0x10", hash: H("a"), stateRoot: H("b") } }, bytes: 10 };
      }
      if (payload.method === "eth_getCode") return { value: { jsonrpc: "2.0", id: payload.id, result: "0x6000" }, bytes: 10 };
      return { value: { jsonrpc: "2.0", id: payload.id, result: "0x0" }, bytes: 10 };
    },
    freePort: async () => 41234,
    createRelay: async (options) => {
      events.relayCreated += 1;
      events.relayUpstream = options.upstreamUrl;
      return { port: 41235, close: async () => { events.relayClosed += 1; } };
    },
    startAnvil: async (args) => {
      events.anvilStarted += 1;
      events.anvilArgs = args;
      return mockChild();
    },
    stopAnvil: async () => { events.anvilStopped += 1; },
    createLocalRpc: () => rpc,
    waitReady: async () => { events.waitReady += 1; },
    loadScenario: () => ({ run: async () => {} }),
    ethers: async () => ({}),
    now: () => Date.now(),
    write: () => {},
    outDir: os.tmpdir(),
  };
  return { deps: { ...deps, ...overrides }, events, rpc };
}

function tmpOut(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-poc-test-"));
  return path.join(dir, `${name}.json`);
}

function baseOptions(overrides = {}) {
  return {
    chain: "1",
    block: "16",
    scenario: "offline-scenario.js",
    scenarioName: "offline-scenario",
    outPath: tmpOut(`run-${Math.random().toString(16).slice(2)}`),
    ...overrides,
  };
}

test("parseArgs rejects unknown or incomplete flags", () => {
  assert.throws(() => poc.parseArgs(["--bogus", "x"]), /USAGE_ERROR/);
  assert.throws(() => poc.parseArgs(["--chain"]), /USAGE_ERROR/);
  assert.throws(() => poc.parseArgs(["--run", "--chain", "1", "--unknown", "x"]), /USAGE_ERROR/);
  assert.throws(() => poc.parseArgs(["--run", "--run"]), /USAGE_ERROR/);
  const parsed = poc.parseArgs(["--run", "--chain", "1", "--block", "finalized", "--scenario", "s.js"]);
  assert.deepEqual(parsed, { run: true, chain: "1", block: "finalized", scenario: "s.js" });
});

test("main refuses without --run and never contacts the network", async () => {
  let contacted = 0;
  const { deps } = harness({
    resolveUpstream: async () => { contacted += 1; return null; },
    transport: async () => { contacted += 1; throw new Error("must-not-contact"); },
  });
  const outcome = await poc.main(["node", "run-fork-poc.js"], deps);
  assert.equal(outcome.status, "USAGE_ERROR");
  assert.equal(outcome.blocker, "EXPLICIT_RUN_REQUIRED");
  assert.equal(contacted, 0);
});

test("main with --run still refuses when --scenario is missing", async () => {
  const { deps } = harness();
  const outcome = await poc.main(["node", "run-fork-poc.js", "--run", "--chain", "1", "--block", "finalized"], deps);
  assert.equal(outcome.status, "USAGE_ERROR");
  assert.equal(outcome.blocker, "USAGE_ERROR");
});

test("leakGuard rejects endpoint/url field names and url strings", () => {
  assert.throws(() => poc.leakGuard({ url: "https://evil.invalid" }), /OUTPUT_SECRET_FIELD_REJECTED/);
  assert.throws(() => poc.leakGuard({ endpoint: "x" }), /OUTPUT_SECRET_FIELD_REJECTED/);
  assert.throws(() => poc.leakGuard({ note: "https://evil.invalid" }), /OUTPUT_URL_REJECTED/);
  assert.throws(() => poc.leakGuard({ nested: { provider: "x" } }), /OUTPUT_SECRET_FIELD_REJECTED/);
  assert.doesNotThrow(() => poc.leakGuard({ note: "safe", value: "1000" }));
});

test("scenario context maps every API method to the intended local RPC", async () => {
  const rpc = mockRpc();
  const ctx = poc.createScenarioContext({ chainId: 1, block: { number: "16" }, localRpc: rpc, ethers: { tag: true } });
  assert.equal(ctx.chainId, 1);
  assert.equal(ctx.chain, "1");
  assert.equal(ctx.blockNumber, "16");
  assert.equal(ctx.ethers.tag, true);

  await ctx.call({ to: ADDR_A, data: DATA });
  await ctx.send({ from: ADDR_A, to: ADDR_B, data: DATA, value: "0x1" });
  await ctx.impersonate(ADDR_A);
  await ctx.stopImpersonating(ADDR_A);
  await ctx.setBalance(ADDR_A, "0x10");
  await ctx.getBalance(ADDR_A);
  await ctx.getStorageAt(ADDR_A, "0x0");
  await ctx.getCode(ADDR_A);
  const snap = await ctx.snapshot();
  await ctx.revert(snap);

  const methods = rpc.calls.map((row) => row.method);
  for (const expected of [
    "eth_call", "anvil_impersonateAccount", "eth_sendTransaction", "eth_getTransactionReceipt",
    "anvil_stopImpersonatingAccount", "anvil_setBalance", "eth_getBalance", "eth_getStorageAt",
    "eth_getCode", "evm_snapshot", "evm_revert",
  ]) {
    assert.equal(methods.includes(expected), true, `missing ${expected}`);
  }
  const sendIndex = methods.indexOf("eth_sendTransaction");
  assert.equal(methods[sendIndex - 1], "anvil_impersonateAccount");
});

test("scenario context performs bounded keyless contract deployment", async () => {
  const calls = [];
  const rpc = { call: async (method, params) => {
    calls.push([method, params]);
    if (method === "eth_sendTransaction") return `0x${"1".repeat(64)}`;
    if (method === "eth_getTransactionReceipt") return { contractAddress: "0x1111111111111111111111111111111111111111", gasUsed: "0x5208", effectiveGasPrice: "0x1" };
    return true;
  } };
  const ctx = poc.createScenarioContext({ chainId: 1, block: { number: "16", hash: `0x${"2".repeat(64)}` }, localRpc: rpc, ethers: {}, scenarioInput: { eventId: "a".repeat(64) } });
  const deployed = await ctx.deploy({ from: "0x2222222222222222222222222222222222222222", data: "0x6000" });
  assert.equal(deployed.address, "0x1111111111111111111111111111111111111111");
  assert.equal(ctx.blockHash, `0x${"2".repeat(64)}`);
  assert.equal(ctx.input.eventId, "a".repeat(64));
  assert.deepEqual(calls.map(([method]) => method), ["anvil_impersonateAccount", "eth_sendTransaction", "eth_getTransactionReceipt"]);
});

test("ctx.log sanitizes values and ctx.assert records pass/fail, honoring ctx.fatal", () => {
  const rpc = mockRpc();
  const ctx = poc.createScenarioContext({ chainId: 1, block: { number: "16" }, localRpc: rpc, ethers: {} });
  const logged = ctx.log("supply", 1_000n);
  assert.equal(logged, "1000");
  assert.deepEqual(ctx._state.observations, [{ label: "supply", value: "1000" }]);

  assert.equal(ctx.assert(true, "ok"), true);
  assert.equal(ctx.assert(false, "nope"), false);
  assert.equal(ctx.fatal, false);

  ctx.fatal = true;
  assert.equal(ctx.fatal, true);
  assert.throws(() => ctx.assert(false, "boom"), /SCENARIO_ASSERT_FAILED/);
});

test("scenario call budget fails closed with a sanitized blocker", async () => {
  const { deps, events } = harness({
    loadScenario: () => ({
      run: async (ctx) => {
        await ctx.call({ to: ADDR_A, data: DATA });
        await ctx.call({ to: ADDR_A, data: DATA });
      },
    }),
  });
  const outcome = await poc.runForkPoc(baseOptions({ limits: { calls: 1 } }), deps);
  assert.equal(outcome.status, "FAIL_CLOSED");
  assert.equal(outcome.blocker, "SCENARIO_CALL_BUDGET_EXHAUSTED");
  assert.equal(events.anvilStopped, 1);
  assert.equal(events.relayClosed, 1);
});

test("Anvil and relay terminate on a scenario throw", async () => {
  const { deps, events } = harness({
    loadScenario: () => ({ run: async () => { throw new Error("boom"); } }),
  });
  const outcome = await poc.runForkPoc(baseOptions(), deps);
  assert.equal(outcome.status, "FAIL_CLOSED");
  assert.equal(outcome.blocker, "UNEXPECTED_SCENARIO_FAILURE");
  assert.equal(events.anvilStarted, 1);
  assert.equal(events.anvilStopped, 1);
  assert.equal(events.relayCreated, 1);
  assert.equal(events.relayClosed, 1);
  assert.equal(outcome.output.cleanup.child, "STOPPED");
  assert.equal(outcome.output.cleanup.relay, "CLOSED");
});

test("evidence shape and safety flags are exact on a PASS run, and no endpoint reaches Anvil argv", async () => {
  const { deps, events } = harness({
    loadScenario: () => ({
      run: async (ctx) => {
        ctx.log("supply", "1000");
        ctx.assert(true, "ok");
      },
    }),
  });
  const outPath = tmpOut("passing");
  const outcome = await poc.runForkPoc(baseOptions({ outPath }), deps);
  assert.equal(outcome.status, "PASS");
  const output = outcome.output;
  assert.equal(output.schema, "fork-poc/v1");
  assert.equal(typeof output.generatedAt, "string");
  assert.equal(output.chainId, 1);
  assert.equal(output.block, "16");
  assert.equal(output.scenarioName, "offline-scenario");
  assert.equal(output.status, "PASS");
  assert.equal(output.result, "PASS");
  assert.equal(output.blocker, null);
  assert.deepEqual(output.safety, {
    localOnly: true,
    impersonationOnly: true,
    noSigning: true,
    noBroadcast: true,
    endpointInventoryPrinted: false,
  });
  assert.equal(output.observations.length, 1);
  assert.equal(output.asserts.length, 1);
  assert.ok(fs.existsSync(outPath));
  const disk = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(disk.schema, "fork-poc/v1");
  assert.equal(disk.observations[0].label, "supply");
  const argvText = events.anvilArgs.join(" ");
  assert.equal(/mock-upstream|evil\.invalid/iu.test(argvText), false);
  assert.equal(events.anvilArgs[events.anvilArgs.indexOf("--fork-url") + 1], "http://127.0.0.1:41235");
  assert.equal(events.anvilArgs.includes("--auto-impersonate"), true);
  assert.equal(events.anvilArgs[events.anvilArgs.indexOf("--accounts") + 1], "0");
});

test("a URL smuggled into an observation fails closed", async () => {
  const { deps } = harness({
    loadScenario: () => ({ run: async (ctx) => { ctx.log("endpoint", "https://evil.invalid"); } }),
  });
  const outcome = await poc.runForkPoc(baseOptions(), deps);
  assert.equal(outcome.status, "FAIL_CLOSED");
  assert.equal(outcome.blocker, "OUTPUT_URL_REJECTED");
  assert.deepEqual(outcome.output.observations, []);
});

test("a failed assert without ctx.fatal yields result FAIL, not a crash", async () => {
  const { deps } = harness({
    loadScenario: () => ({ run: async (ctx) => { ctx.assert(false, "nope"); } }),
  });
  const outcome = await poc.runForkPoc(baseOptions(), deps);
  assert.equal(outcome.status, "FAIL");
  assert.equal(outcome.output.blocker, null);
  assert.deepEqual(outcome.output.asserts, [{ label: "nope", pass: false }]);
});

test("archive-unavailable upstream fails closed before any child process starts", async () => {
  const { deps, events } = harness({
    transport: async (_url, payload) => ({ value: { jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "missing trie node" } }, bytes: 10 }),
  });
  const outcome = await poc.runForkPoc(baseOptions(), deps);
  assert.equal(outcome.status, "FAIL_CLOSED");
  assert.equal(outcome.blocker, "ARCHIVE_UPSTREAM_UNAVAILABLE");
  assert.equal(events.anvilStarted, 0);
  assert.equal(events.relayCreated, 0);
});

test("missing upstream fails closed", async () => {
  const { deps, events } = harness({ resolveUpstream: async () => null });
  const outcome = await poc.runForkPoc(baseOptions(), deps);
  assert.equal(outcome.status, "FAIL_CLOSED");
  assert.equal(outcome.blocker, "UPSTREAM_UNAVAILABLE");
  assert.equal(events.anvilStarted, 0);
});

test("stopImpersonating tolerates an already-reverted / non-impersonated account", async () => {
  const rpc = mockRpc({ anvil_stopImpersonatingAccount: () => { throw new Error("account not impersonated"); } });
  const ctx = poc.createScenarioContext({ chainId: 1, block: { number: "16" }, localRpc: rpc, ethers: {} });
  const result = await ctx.stopImpersonating(ADDR_A);
  assert.equal(result, false);
  assert.equal(ctx._state.impersonated.has(ADDR_A), false);
});

test("scenario that stops impersonation on a non-impersonated account still PASSes", async () => {
  const { deps } = harness({
    rpc: mockRpc({ anvil_stopImpersonatingAccount: () => { throw new Error("not impersonated"); } }),
    loadScenario: () => ({
      run: async (ctx) => {
        await ctx.impersonate(ADDR_A);
        await ctx.setBalance(ADDR_A, "0x10");
        const stopped = await ctx.stopImpersonating(ADDR_A);
        ctx.log("stopped", stopped);
        ctx.assert(stopped === false, "tolerant-stop");
      },
    }),
  });
  const outcome = await poc.runForkPoc(baseOptions(), deps);
  assert.equal(outcome.status, "PASS");
  assert.equal(outcome.blocker, null);
  assert.deepEqual(outcome.output.asserts, [{ label: "tolerant-stop", pass: true }]);
});

test("failure artifact is written with pre-failure observations, status, blocker, and safety", async () => {
  const { deps } = harness({
    loadScenario: () => ({
      run: async (ctx) => {
        ctx.log("beforeFailure", "42");
        ctx.assert(true, "pre-ok");
        throw new Error("boom");
      },
    }),
  });
  const outPath = tmpOut("failing");
  const outcome = await poc.runForkPoc(baseOptions({ outPath }), deps);
  assert.equal(outcome.status, "FAIL_CLOSED");
  assert.ok(fs.existsSync(outPath));
  const disk = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(disk.schema, "fork-poc/v1");
  assert.equal(disk.status, "FAIL_CLOSED");
  assert.equal(disk.blocker, "UNEXPECTED_SCENARIO_FAILURE");
  assert.equal(disk.observations.length, 1);
  assert.equal(disk.observations[0].label, "beforeFailure");
  assert.equal(disk.asserts.length, 1);
  assert.deepEqual(disk.safety, {
    localOnly: true,
    impersonationOnly: true,
    noSigning: true,
    noBroadcast: true,
    endpointInventoryPrinted: false,
  });
});

test("teardown always attempts impersonation, Anvil, and relay cleanup after a throw", async () => {
  const { deps, events, rpc } = harness({
    loadScenario: () => ({
      run: async (ctx) => {
        await ctx.impersonate(ADDR_B);
        throw new Error("boom");
      },
    }),
  });
  const outcome = await poc.runForkPoc(baseOptions(), deps);
  assert.equal(outcome.status, "FAIL_CLOSED");
  assert.equal(events.anvilStopped, 1);
  assert.equal(events.relayClosed, 1);
  assert.equal(rpc.calls.some((row) => row.method === "anvil_stopImpersonatingAccount" && row.params[0] === ADDR_B), true);
  assert.equal(outcome.output.cleanup.child, "STOPPED");
  assert.equal(outcome.output.cleanup.relay, "CLOSED");
});

test("runCli never surfaces an uncaught stack trace on a scenario throw", async () => {
  const { deps } = harness({
    loadScenario: () => ({ run: async () => { throw new Error("boom"); } }),
  });
  deps.outDir = path.dirname(tmpOut("cli-artifact"));
  const previousExitCode = process.exitCode;
  try {
    const outcome = await poc.runCli(
      ["node", "run-fork-poc.js", "--run", "--chain", "1", "--block", "16", "--scenario", "cli-scenario.js"],
      deps,
    );
    assert.equal(outcome.status, "FAIL_CLOSED");
    assert.equal(outcome.blocker, "UNEXPECTED_SCENARIO_FAILURE");
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("sanitizeRpcDetail redacts endpoint material and bounds the detail", () => {
  const approved = require("./run-approved-fork-validation");
  assert.equal(approved.sanitizeRpcDetail(null), null);
  assert.equal(approved.sanitizeRpcDetail("not-an-object"), null);
  assert.equal(approved.sanitizeRpcDetail({}), null);
  const detail = approved.sanitizeRpcDetail({
    message: "execution reverted at https://secret.invalid/x api_key=abc123",
    data: `0x${"ab".repeat(100)}`,
  });
  assert.doesNotMatch(detail, /secret\.invalid|abc123|https?:/iu);
  assert.match(detail, /execution reverted/u);
  assert.match(detail, /data=0xabab/u);
  assert.ok(detail.length <= 240);
});

test("a local RPC method failure persists a bounded sanitized blockerDetail", async () => {
  const failure = new poc.ForkError("LOCAL_RPC_METHOD_FAILED", "LOCAL_RPC_eth_sendTransaction");
  failure.detail = "execution reverted: gross";
  const { deps } = harness({
    createLocalRpc: () => ({ call: async () => { throw failure; } }),
    loadScenario: () => ({ run: async (ctx) => { await ctx.call({ to: ADDR_A, data: DATA }); } }),
  });
  const outPath = tmpOut("rpc-detail");
  const outcome = await poc.runForkPoc(baseOptions({ outPath }), deps);
  assert.equal(outcome.status, "FAIL_CLOSED");
  assert.equal(outcome.blocker, "LOCAL_RPC_METHOD_FAILED");
  const disk = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(disk.blockerDetail, "execution reverted: gross");
});

test("a reverted local transaction fails closed with a distinct sanitized code", async () => {
  const { deps } = harness({
    rpc: mockRpc({ eth_getTransactionReceipt: () => ({ status: "0x0", gasUsed: "0x5208" }) }),
    loadScenario: () => ({ run: async (ctx) => { await ctx.send({ from: ADDR_A, to: ADDR_B, data: DATA }); } }),
  });
  const outPath = tmpOut("reverted");
  const outcome = await poc.runForkPoc(baseOptions({ outPath }), deps);
  assert.equal(outcome.status, "FAIL_CLOSED");
  assert.equal(outcome.blocker, "SCENARIO_TX_REVERTED");
  const disk = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.match(disk.blockerDetail, /^status=0x0 gasUsed=21000/u);
});

test("receipt polling tolerates a not-yet-mined receipt then succeeds", async () => {
  let receipts = 0;
  const rpc = mockRpc({ eth_getTransactionReceipt: () => (++receipts === 1 ? null : { status: "0x1", gasUsed: "0x5208" }) });
  const { deps } = harness({
    rpc,
    loadScenario: () => ({ run: async (ctx) => { await ctx.send({ from: ADDR_A, to: ADDR_B, data: DATA }); } }),
  });
  const outcome = await poc.runForkPoc(baseOptions(), deps);
  assert.equal(outcome.status, "PASS");
});

test("the fork relay forwards only read-only receipt/history methods", () => {
  const approved = require("./run-approved-fork-validation");
  for (const method of ["eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockReceipts"]) {
    assert.equal(approved.UPSTREAM_METHODS.has(method), true, method);
  }
  for (const method of ["eth_sendRawTransaction", "eth_sign", "personal_sign", "anvil_setBalance"]) {
    assert.equal(approved.UPSTREAM_METHODS.has(method), false, method);
  }
});

test("runCli also fails closed when fork setup throws before any artifact exists", async () => {
  const { deps } = harness({ transport: async (_url, payload) => ({ value: { jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "missing trie node" } }, bytes: 10 }) });
  deps.outDir = path.dirname(tmpOut("cli-no-fork"));
  const previousExitCode = process.exitCode;
  try {
    const outcome = await poc.runCli(
      ["node", "run-fork-poc.js", "--run", "--chain", "1", "--block", "16", "--scenario", "cli-scenario.js"],
      deps,
    );
    assert.equal(outcome.status, "FAIL_CLOSED");
    assert.equal(outcome.blocker, "ARCHIVE_UPSTREAM_UNAVAILABLE");
  } finally {
    process.exitCode = previousExitCode;
  }
});
