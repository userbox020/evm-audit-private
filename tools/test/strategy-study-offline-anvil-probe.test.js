"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const { EventEmitter } = require("node:events"), crypto = require("node:crypto"), cp = require("node:child_process"), probe = require("../strategy-study/offline-anvil-probe");
const OLD_SHA256 = "a4f07348f08143a34bc3d281deef847da36008149fdaa9ac4b64be7c7bc2c584";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function transport(result = "0x7a69", error = null) {
  return (options, respond) => {
    assert.equal(options.hostname, "127.0.0.1"); assert.equal(options.path, "/"); assert.equal(options.agent, false);
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => { const input = JSON.parse(body); queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 200; res.destroy = () => {}; respond(res);
      res.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: input.id, ...(error ? { error } : { result }) }))); res.emit("end");
    }); }; return req;
  };
}
test("import is inert and has no workspace, environment, filesystem, process or network effects", () => {
  const filename = require.resolve("../strategy-study/offline-anvil-probe"), module = { exports: {} }, blocked = new Proxy({}, { get() { throw new Error("I/O during import"); } });
  const allowed = new Set(["node:fs", "node:path", "node:os", "node:crypto", "node:http", "node:net", "node:child_process"]);
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, __dirname: path.dirname(filename), Buffer, process: blocked,
    require(name) { assert.ok(allowed.has(name)); return ["node:path", "node:crypto"].includes(name) ? require(name) : blocked; } }, { filename });
  assert.equal(typeof module.exports.runProbe, "function");
});
test("runtime hash/version/commit pins fail closed before any node qualification", () => {
  const version = `anvil Version: ${probe.PIN.version}\nCommit SHA: ${probe.PIN.commit}`;
  assert.deepEqual(probe.validateRuntimeIdentity(probe.PIN.sha256, version), probe.PIN);
  assert.throws(() => probe.validateRuntimeIdentity("0".repeat(64), version), /runtime-pin-mismatch/);
  assert.throws(() => probe.validateRuntimeIdentity(probe.PIN.sha256, version.replace("1.5.1", "1.5.2")), /runtime-version-mismatch/);
  assert.throws(() => probe.validateRuntimeIdentity(probe.PIN.sha256, "1.5.1-stable"), /runtime-version-mismatch/);
});
test("eight bounded fixtures and only their exact local methods/params/configs are admitted", () => {
  const fixtures = probe.fixtures(); assert.equal(fixtures.length, 8);
  for (const fixture of fixtures) {
    for (const code of fixture.codes) { assert.match(code.bytecode, /^0x(?:[a-f0-9]{2})*$/); assert.ok(code.bytecode.length < 512); probe.validateRequest("anvil_setCode", [code.address, code.bytecode]); }
    probe.validateRequest("debug_traceCall", [fixture.input, "0x0", probe.OPCODE_CONFIG]); probe.validateRequest("debug_traceCall", [fixture.input, "0x0", probe.NATIVE_CONFIG]);
  }
  for (const host of ["localhost", "0.0.0.0", "::1", "192.0.2.1"]) assert.throws(() => probe.validateTarget({ host, port: 12345 }), /local-target-rejected/);
  assert.throws(() => probe.validateTarget({ host: "127.0.0.1", port: 12345, url: "forbidden" }), /local-target-rejected/);
  for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "debug_traceTransaction", "eth_call", "anvil_reset", "anvil_mine"]) assert.throws(() => probe.validateRequest(method, []), /local-request-rejected/);
  for (const params of [[fixtures[0].input, "latest", probe.OPCODE_CONFIG], [fixtures[0].input, "0x0", { ...probe.OPCODE_CONFIG, timeout: "10s" }],
    [{ ...fixtures[0].input, gas: "0xffffff" }, "0x0", probe.OPCODE_CONFIG], [fixtures[0].input, "0x0", probe.OPCODE_CONFIG, {}]]) assert.throws(() => probe.validateRequest("debug_traceCall", params), /local-request-rejected/);
  assert.throws(() => probe.validateRequest("anvil_setCode", [fixtures[0].root, "0xfe"]), /local-request-rejected/);
});
test("local client bounds requests, response/total bytes and elapsed time without retaining RPC error text", async () => {
  const target = { host: "127.0.0.1", port: 12345 };
  const client = probe.createLocalClient(target, { request: transport(), limits: { requests: 1 } }); assert.equal(await client.rpc("eth_chainId", []), "0x7a69");
  await assert.rejects(client.rpc("eth_chainId", []), /request-budget-exceeded/);
  await assert.rejects(probe.createLocalClient(target, { request: transport(), limits: { responseBytes: 1 } }).rpc("eth_chainId", []), /response-budget-exceeded/);
  const total = probe.createLocalClient(target, { request: transport(), limits: { totalBytes: 70 } }); await total.rpc("eth_chainId", []); await assert.rejects(total.rpc("eth_chainId", []), /total-budget-exceeded/);
  await assert.rejects(probe.createLocalClient(target, { request: transport(null, { code: -32000, message: "PRIVATE_RPC_SENTINEL" }) }).rpc("eth_chainId", []), error => error.message === "local-rpc-error");
  let clock = 0; const timed = probe.createLocalClient(target, { now: () => clock, request: transport() }); clock = probe.BOUNDS.watchdogMs; await assert.rejects(timed.rpc("eth_chainId", []), /lifetime-exceeded/);
  assert.throws(() => probe.createLocalClient(target, { limits: { requests: 101 } }), /invalid-options/);
});
test("local request timeout destroys its socket independently of an EVM timeout assumption", async () => {
  let destroyed = false;
  const client = probe.createLocalClient({ host: "127.0.0.1", port: 12345 }, { limits: { requestMs: 5 }, request() { const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { destroyed = true; }; return req; } });
  await assert.rejects(client.rpc("eth_chainId", []), /local-timeout/); assert.equal(destroyed, true);
});
test("supervision kills only the supplied owned PID and confirms exit on normal stop and watchdog", async () => {
  for (const watchdog of [false, true]) {
    const child = new EventEmitter(); Object.assign(child, { pid: 12345, exitCode: null, signalCode: null }); let killed = 0;
    const owned = probe.supervise(child, async pid => { assert.equal(pid, child.pid); killed++; child.exitCode = 0; child.emit("exit", 0); }, watchdog ? 5 : 1000);
    if (watchdog) await new Promise(resolve => setTimeout(resolve, 15));
    const result = await owned.stop(); await owned.stop(); assert.equal(killed, 1); assert.equal(result.childExited, true); assert.equal(result.watchdogTriggered, watchdog);
  }
});
test("recognized terminal static LOG attempt is not coerced into an emission", () => {
  assert.equal(probe.safeTrace({ error: "StateChangeDuringStaticCall" }).errorDiagnostics[0].recognized, true);
  const fixture = probe.fixtures()[4], steps = [
    { pc: 4, op: "LOG0", depth: 2, gas: 49000, stack: [], memory: [], error: "StateChangeDuringStaticCall" },
    { pc: 40, op: "STOP", depth: 1, gas: 90000, stack: [], memory: [] },
  ];
  const assessed = probe.assess(fixture, { failed: false, gas: 60000, structLogs: steps }, { calls: [{ error: "StateChangeDuringStaticCall" }] });
  assert.equal(assessed.passed, true); assert.equal(assessed.observations.logAttempts, 1); assert.equal(assessed.observations.postLogContinuations, 0); assert.equal(fixture.truth.committedLogs, 0);
});

test("old FAILED artifact stays immutable while its raw reverted-root log is interpreted separately from commitment", () => {
  const bytes = fs.readFileSync(probe.RESULT_PATH); assert.equal(digest(bytes), OLD_SHA256);
  const old = JSON.parse(bytes), row = old.fixtures[1], fixture = probe.fixtures()[1];
  assert.equal(old.status, "FAILED"); assert.equal(row.status, "FAILED"); assert.equal(row.truth.nativeVisibleLogs, 0);
  const assessed = probe.assess(fixture, row.opcodeTrace, row.nativeTrace);
  assert.equal(assessed.passed, true); assert.equal(assessed.observations.nativeVisibleLogs, 1); assert.equal(assessed.observations.nativeAncestorCommittedLogs, 0);
  assert.equal(fixture.truth.nativeVisibleLogs, 1); assert.equal(fixture.truth.committedLogs, 0);
  assert.deepEqual(probe.safeTrace(row.nativeTrace).trace, row.nativeTrace); // Includes the original uncommitted log index.
  for (const saved of old.fixtures) {
    const current = probe.fixtures().find(f => f.id === saved.id); assert.deepEqual(current.codes, saved.codes); assert.deepEqual(current.input, saved.input);
  }
  assert.deepEqual(old.bounds, probe.BOUNDS); assert.deepEqual(old.configs, { opcode: probe.OPCODE_CONFIG, native: probe.NATIVE_CONFIG }); assert.deepEqual(old.runtimeIdentity, probe.PIN);
  const cli = cp.spawnSync(process.execPath, [require.resolve("../strategy-study/offline-anvil-probe"), "--run-offline"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(cli.status, 2); assert.deepEqual(JSON.parse(cli.stdout), { status: "FAILED", reason: "output-exists" }); assert.equal(cli.stderr, "");
  assert.equal(digest(fs.readFileSync(probe.RESULT_PATH)), OLD_SHA256);
});

test("commitment excludes a failed frame and all descendants without filtering raw native logs", () => {
  const saved = JSON.parse(fs.readFileSync(probe.RESULT_PATH)), rootRevert = saved.fixtures[1], rootSuccess = saved.fixtures[0];
  const log = { address: probe.fixtures()[0].root, data: "0x", topics: [], index: "0x123" };
  const native = { logs: [log], calls: [{ logs: [log], calls: [{ logs: [log] }] }] };
  let assessed = probe.assess(probe.fixtures()[0], rootSuccess.opcodeTrace, native);
  assert.equal(assessed.observations.nativeVisibleLogs, 3); assert.equal(assessed.observations.nativeAncestorCommittedLogs, 3);
  native.calls[0].error = "execution reverted"; assessed = probe.assess(probe.fixtures()[0], rootSuccess.opcodeTrace, native);
  assert.equal(assessed.observations.nativeVisibleLogs, 3); assert.equal(assessed.observations.nativeAncestorCommittedLogs, 1);
  native.error = "execution reverted"; assessed = probe.assess(probe.fixtures()[1], rootRevert.opcodeTrace, native);
  assert.equal(assessed.observations.nativeVisibleLogs, 3); assert.equal(assessed.observations.nativeAncestorCommittedLogs, 0);
  assert.equal(native.calls[0].calls[0].logs[0].index, "0x123");
});

test("bounded unknown local errors retain original strings or key/type diagnostics, never unknown success", () => {
  const retained = probe.safeTrace({ error: "EvmError: SyntheticUnknownFault" });
  assert.equal(retained.trace.error, "EvmError: SyntheticUnknownFault"); assert.equal(retained.errorDiagnostics[0].recognized, false);
  assert.equal(retained.errorDiagnostics[0].originalValueRetained, true);
  const nested = probe.safeTrace({ error: { Fault: { privatePayload: "NESTED_PAYLOAD_SENTINEL" }, detail: "NOT_RETAINED_SENTINEL" } });
  assert.equal(nested.errorDiagnostics[0].recognized, false); assert.equal(nested.errorDiagnostics[0].originalValueRetained, false);
  assert.deepEqual(nested.trace.error, { diagnosticOnly: true, valueType: "object", keys: [{ key: "Fault", valueType: "object" }, { key: "detail", valueType: "string" }] });
  assert.ok(!JSON.stringify(nested).includes("SENTINEL"));
  const saved = JSON.parse(fs.readFileSync(probe.RESULT_PATH)).fixtures[0];
  const assessed = probe.assess(probe.fixtures()[0], saved.opcodeTrace, { ...saved.nativeTrace, error: "SyntheticUnknownFault" });
  assert.equal(assessed.passed, false); assert.equal(assessed.errorSemanticsKnown, false); assert.equal(assessed.observations.nativeAncestorCommittedLogs, null);
  for (const error of ["http://example.invalid/path", "wss://example.invalid", "example.invalid", "127.0.0.1:8545", "user:pass", "token=abc", "Authorization: abc", "abc@def", "a\nb", "a\tb", "a\u0000b", "\u007f", "\u00e9", "x".repeat(161)])
    assert.throws(() => probe.safeTrace({ error }), e => e.message === "trace-error-retention-rejected");
  assert.throws(() => probe.safeTrace({ error: { "http://example.invalid": 1 } }), /trace-error-retention-rejected/);
  assert.throws(() => probe.safeTrace({ error: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`key${i}`, 1])) }), /trace-error-retention-rejected/);
  let deep = {}; for (let i = 0; i < 64; i++) deep = { child: deep }; assert.throws(() => probe.safeTrace(deep), /trace-shape-invalid/);
});

function mockPair(fixture) {
  const t = fixture.truth, step = (op, pc, depth) => ({ op, pc, depth, gas: 50000, stack: [], memory: [] }), steps = [];
  if (t.logAttempts) {
    const depth = Object.hasOwn(t, "childFailed") ? 2 : 1; steps.push(step("LOG0", 4, depth));
    if (t.terminalStaticFault) steps[0].error = "StateChangeDuringStaticCall";
    else steps.push(step(depth === 1 && t.rootFailed || t.childFailed ? "REVERT" : "STOP", 5, depth));
  }
  if (!steps.length || steps.at(-1).depth !== 1) steps.push(step(t.rootFailed ? "REVERT" : "STOP", 40, 1));
  const native = { to: fixture.root, ...(t.rootFailed ? { error: "execution reverted" } : {}) };
  if (Object.hasOwn(t, "childFailed")) native.calls = [{ to: fixture.codes[1].address,
    ...(t.childFailed ? { error: t.terminalStaticFault ? "StateChangeDuringStaticCall" : "execution reverted" } : {}) }];
  if (t.nativeVisibleLogs) (native.calls?.[0] || native).logs = [{ address: t.emitter || fixture.root, topics: [], data: t.logData || "0x", index: "0x0" }];
  if (t.zeroStepChildren) native.calls = t.zeroStepChildren.map(to => ({ to }));
  return { opcode: { failed: t.rootFailed, gas: 60000, structLogs: steps }, native };
}

test("semantic unknown keeps both traces, continues all eight fixed fixtures and leaves overall failure sticky", async () => {
  for (const structured of [false, true]) {
    const rows = []; let calls = 0;
    const outcome = await probe.collectFixtureTraces(async (method, params) => {
      probe.validateRequest(method, params); calls++; const fixture = probe.fixtures().find(f => f.root === params[0].to), pair = mockPair(fixture);
      if (fixture.truth.terminalStaticFault) {
        pair.opcode.structLogs[0].error = "SyntheticUnknownFault";
        pair.native.calls[0].error = structured ? { UnknownFault: { payload: "NESTED_SENTINEL" } } : "SyntheticUnknownFault";
      }
      return params[2].tracer ? pair.native : pair.opcode;
    }, rows);
    assert.equal(calls, 16); assert.equal(rows.length, 8); assert.equal(outcome.status, "FAILED"); assert.equal(outcome.reason, "trace-error-literal-unrecognized");
    assert.equal(outcome.supported.actualOpcodeAndNativePairs, 8); assert.equal(outcome.supported.allExpectedFixtureAssertions, false);
    assert.equal(rows[4].status, "NOTQUALIFIED"); assert.ok(rows[4].opcodeTrace && rows[4].nativeTrace); assert.equal(rows[4].errorDiagnostics.length, 2);
    assert.ok(rows.filter((_, i) => i !== 4).every(row => row.status === "PASSED")); assert.ok(!JSON.stringify(rows).includes("NESTED_SENTINEL"));
  }
  for (const mode of ["transport", "security", "size"]) {
    const rows = []; let calls = 0;
    await assert.rejects(probe.collectFixtureTraces(async () => {
      calls++; if (mode !== "security") throw new Error(mode === "transport" ? "local-transport-failure" : "response-budget-exceeded");
      return { error: "https://example.invalid" };
    }, rows), new RegExp(mode === "transport" ? "local-transport-failure" : mode === "security" ? "trace-error-retention-rejected" : "response-budget-exceeded"));
    assert.equal(calls, 1); assert.equal(rows.length, 1); assert.equal(rows[0].opcodeTrace, null);
  }
});

test("CLI has only two fixed destinations and refuses collisions before runtime I/O", async () => {
  const filename = require.resolve("../strategy-study/offline-anvil-probe"), module = { exports: {} }, seen = [], output = [];
  const blocked = new Proxy({}, { get() { throw new Error("unexpected runtime I/O"); } });
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, __dirname: path.dirname(filename), Buffer, process: blocked, console: { log(text) { output.push(JSON.parse(text)); } },
    require(name) { if (name === "node:fs") return { existsSync(file) { seen.push(file); return true; } }; return ["node:path", "node:crypto"].includes(name) ? require(name) : blocked; } }, { filename });
  for (const flag of ["--run-offline", "--run-offline-r2"]) { assert.equal(await module.exports.main([flag]), 2); assert.equal(output.at(-1).reason, "output-exists"); }
  assert.deepEqual(seen, [probe.RESULT_PATH, probe.R2_RESULT_PATH]);
  for (const args of [["--out=x"], ["--run-offline-r3"], ["--run-offline-r2", "--out=x"], ["--run-offline-r2", "--run-offline"]]) {
    assert.equal(await module.exports.main(args), 2); assert.equal(output.at(-1).reason, "invalid-options");
  }
  assert.equal(seen.length, 2);
});
