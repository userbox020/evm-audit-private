"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AbiCoder, id } = require("ethers");
const gate = require("../atomic/lido-nest-bootstrap-gate4");
const validator = require("../atomic/lido-nest-bootstrap-gate4/validator");
const { PROGRAM_PINS, PUBLICATIONS, TARGET_PINS } = require("../atomic/lido-nest-bootstrap-gate4/authority");

const ROOT = path.resolve(__dirname, "../..");
const TARGET_ROOT = path.join(ROOT, "targets", "lido-nest-explorer-verified-20260826");
const ZERO = "0x0000000000000000000000000000000000000000";
const FEED = `0x${"44".repeat(20)}`;

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lido-a4-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fixtureAuthority() {
  const parsed = {}, facts = {};
  for (const [name, pin] of Object.entries(TARGET_PINS)) {
    const bytes = fs.readFileSync(path.join(TARGET_ROOT, pin.filename)), json = JSON.parse(bytes), runtime = Buffer.from(json.deployed_bytecode.slice(2), "hex");
    parsed[name] = json;
    facts[name] = { filename: pin.filename, bundle: { bytes: bytes.length, sha256: validator.sha(bytes) }, runtime: { bytes: runtime.length, sha256: validator.sha(runtime) }, address: pin.address, authority: pin.source };
  }
  const authority = gate.buildProductionAuthority({
    pubs: { a1: { manifest: PUBLICATIONS.a1.manifest }, a2: { manifest: PUBLICATIONS.a2.manifest }, a3: { manifest: PUBLICATIONS.a3.manifest } },
    programs: { facts: PROGRAM_PINS.pending ? { fixture: true } : PROGRAM_PINS }, targets: { facts, parsed },
  });
  delete authority.recheck;
  return authority;
}
function header(number = 100, change = {}) {
  return { number: `0x${number.toString(16)}`, hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, stateRoot: `0x${"33".repeat(32)}`, timestamp: "0x186a0", baseFeePerGas: "0x174876e800", gasLimit: "0x1c9c380", gasUsed: "0xe4e1c0", ...change };
}
function candidates() {
  return [
    { url: new URL("https://alpha.example/rpc?secret=a"), headers: { Authorization: "secret-a" }, family: "explicit:one", inventoryOrder: 0, capabilityRank: 1 },
    { url: new URL("https://beta.invalid/rpc?secret=b"), headers: { "x-key": "secret-b" }, family: "explicit:two", inventoryOrder: 1, capabilityRank: 2 },
  ];
}

function mock(authority, change = {}) {
  const calls = [], block = header(100, { baseFeePerGas: change.baseFee || "0x174876e800" });
  const encode = (iface, method, values) => iface.encodeFunctionResult(method, values);
  const transport = async (candidate, method, params) => {
    calls.push({ candidate: candidate.family, method, params });
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "finalized") return header(100, { baseFeePerGas: change.baseFee || "0x174876e800" });
      if (candidate.badHeader) return { ...block, stateRoot: `0x${"99".repeat(32)}` };
      return block;
    }
    if (method === "eth_getBlockByHash") return block;
    if (method === "eth_getCode") {
      const address = params[0].toLowerCase();
      if (address === gate.SENTINEL) return "0x";
      if (address === FEED) return change.emptyFeedCode ? "0x" : change.oversizeFeedCode ? `0x${"60".repeat(24577)}` : "0x6000";
      const mapping = { [authority.addresses.executor]: "executor", [authority.addresses.oracle]: "oracleRouter", [authority.addresses.pool]: "pool", [authority.addresses.math]: "math", [authority.addresses.views]: "views", [authority.addresses.factory]: "factory", [authority.addresses.stonks]: "stonks" };
      const name = mapping[address];
      if (!name) return "0x";
      if (change.runtimeMismatch === name) return "0x6001";
      if (change.badStonks === "runtime" && name === "stonks") return "0x6001";
      return authority.runtimes[name];
    }
    if (method === "eth_estimateGas") {
      if (change.estimateError) return { error: change.estimateError };
      return "0x186a0";
    }
    if (method !== "eth_call") throw new Error("unsupported mock method");
    const tx = params[0], data = tx.data.toLowerCase(), target = tx.to.toLowerCase();
    if (data === "0x") return { error: { code: 3, message: "execution reverted", data: "0x" } };
    if (tx.from) {
      if (change.providerDisagreement && candidate.family === "explicit:two") return encode(authority.interfaces.executor, "addLiquidity", [1n]);
      if (Object.hasOwn(change, "revert")) return { error: { code: 3, message: "execution reverted", data: change.revert } };
      if (change.emptyReturn) return "0x";
      return encode(authority.interfaces.executor, "addLiquidity", [123n]);
    }
    let scope, iface;
    if (target === authority.addresses.executor) { scope = "executor"; iface = authority.interfaces.executor; }
    else if (target === authority.addresses.pool) { scope = "pool"; iface = authority.interfaces.pool; }
    else if (target === authority.addresses.oracle) { scope = "oracle"; iface = authority.interfaces.oracle; }
    else if (target === authority.addresses.factory) { scope = "factory"; iface = authority.interfaces.factory; }
    else if (target === authority.addresses.stonks) { scope = "stonks"; iface = authority.interfaces.stonks; }
    else if (target === authority.addresses.wstEth) { scope = "wst"; iface = authority.interfaces.wst; }
    else if (target === authority.addresses.ldo || target === authority.addresses.stEth) { scope = "erc20"; iface = authority.interfaces.erc20; }
    else if (target === FEED || target === "0x47fb2585d2c56fe188d0e6ec628a38b74fceeedf") { scope = "registry"; iface = authority.interfaces.registry; }
    else throw new Error(`unknown target ${target}`);
    const fragment = iface.getFunction(data.slice(0, 10)), fn = fragment.name;
    if (scope === "executor") {
      const canAdd = change.canAddLiquidity ?? !Object.hasOwn(change, "revert");
      const values = { CURVE_POOL_AND_TOKEN: [authority.addresses.pool], STETH: [authority.addresses.stEth], WSTETH: [authority.addresses.wstEth], LDO: [authority.addresses.ldo], ORACLE_ROUTER: [authority.addresses.oracle], TREASURY: [authority.addresses.treasury], PRICE_UNIT: [10n ** 18n], paused: [false], lpModeEnabled: [change.lpModeEnabled ?? true], stonks: [change.badStonks === "zero" ? ZERO : authority.addresses.stonks], poolBootstrapMinTvlUsd: [250000n * 10n ** 18n], poolPriceDivergenceToleranceBps: [200n], minDepositValueUsd: [1000n * 10n ** 18n], maxDepositValueUsd: [50000n * 10n ** 18n], canAddLiquidity: [canAdd], getAvailableLiquidity: [2n * 10n ** 18n, 3n * 10n ** 18n], getLpTokenBalance: [0n] };
      return encode(iface, fn, values[fn]);
    }
    if (scope === "pool") {
      const nonempty = change.nonempty, oneZero = change.oneZero;
      const values = { MATH: [authority.addresses.math], factory: [authority.addresses.factory], totalSupply: [nonempty || oneZero ? 1n : 0n], D: [nonempty || oneZero ? 1n : 0n], balances: [oneZero && fn === "balances" && BigInt(iface.decodeFunctionData(fn, data)[0]) === 1n ? 0n : nonempty || oneZero ? 10n : 0n], price_oracle: [9600n * 10n ** 18n], price_scale: [9600n * 10n ** 18n], last_prices: [9600n * 10n ** 18n], last_timestamp: [900n], A: [400000n], gamma: [100n], balanceOf: [0n] };
      return encode(iface, fn, values[fn]);
    }
    if (scope === "factory") return encode(iface, fn, [authority.addresses.views]);
    if (scope === "erc20") return encode(iface, fn, [change.nonempty || change.oneZero ? 10n : change.donation ? 1n : 0n]);
    if (scope === "wst") return fn === "stEthPerToken" ? encode(iface, fn, [1200000000000000000n]) : encode(iface, fn, [change.nonempty ? 10n : change.oneZero ? 0n : change.donation ? 1n : 0n]);
    if (scope === "stonks") {
      const values = { RECEIVER: [change.badStonks === "receiver" ? ZERO : authority.addresses.executor], manager: [change.badStonks === "manager" ? ZERO : authority.addresses.executor], getOrderParameters: [change.badStonks === "tokens" ? authority.addresses.ldo : authority.addresses.stEth, authority.addresses.ldo, change.badStonks === "tupleDuration" ? 1n : 1800n], ORDER_DURATION_IN_SECONDS: [change.badStonks === "duration" ? 1n : 1800n] };
      return encode(iface, fn, values[fn]);
    }
    if (scope === "oracle") {
      if (fn === "getUsdPrices") return encode(iface, fn, [250000000000000000n, 2000n * 10n ** 18n]);
      if (fn === "FEED_REGISTRY") return encode(iface, fn, ["0x47fb2585d2c56fe188d0e6ec628a38b74fceeedf"]);
      return encode(iface, fn, [10n ** 18n]);
    }
    if (scope === "registry") {
      if (fn === "getFeed") return encode(iface, fn, [change.zeroFeed ? ZERO : FEED]);
      if (fn === "decimals") return encode(iface, fn, [change.decimals ?? 8]);
      const roundId = change.roundId ?? 1n, started = change.startedAt ?? 99900n, updated = change.updatedAt ?? 99950n, answered = change.answeredInRound ?? roundId;
      return encode(iface, fn, [roundId, change.answer ?? 3000n * 10n ** 8n, started, updated, answered]);
    }
    throw new Error("unhandled mock call");
  };
  return { calls, transport };
}
async function run(change = {}) {
  const authority = fixtureAuthority(), mocked = mock(authority, change), result = await gate.runGate({ authority, candidates: candidates(), transport: mocked.transport, now: (() => { let value = 1000000; return () => value++; })() });
  return { authority, mocked, result };
}

test("preflight pins programs, Node, dependency tree, A1/A2/A3, and all consumed targets", { skip: PROGRAM_PINS.pending }, () => {
  const pre = gate.productionPreflight();
  assert.equal(pre.pubs.a3.files["stage-a3-verdict.json"].classification, "WATCH_SYNTHETIC_POSITIVE_CANDIDATE");
  assert.deepEqual(pre.pubs.a3.files["candidate-results.json"].repeatPairIds, PUBLICATIONS.a3.repeats);
  assert.ok(pre.programs.facts.node.bytes > 0 && pre.programs.facts.dependencies.files > 0);
  assert.deepEqual(Object.keys(pre.targets.facts).sort(), Object.keys(TARGET_PINS).sort());
});
test("CLI modes are exact and preflight cannot capture or write", async () => {
  const stdout = [], stderr = []; let preflight = 0, collected = 0, exitCode = 0;
  const deps = { preflight: () => { preflight++; }, collect: async () => { collected++; }, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), setExitCode: (code) => { exitCode = code; } };
  assert.equal((await gate.runCli(["--preflight-only"], deps)).ok, true); assert.equal(preflight, 1); assert.equal(collected, 0);
  const summary = JSON.parse(stdout[0]); assert.equal(summary.readOnlyLiveRpcCaptureStarted, false); assert.equal(summary.readOnlyLiveRpcCaptureCompleted, false); assert.equal(summary.wroteArtifacts, false);
  assert.equal((await gate.runCli(["--preflight-only", "--live-capture"], deps)).ok, false); assert.equal(exitCode, 1); assert.match(stderr.at(-1), /lido-nest-a4-cli-invalid/);
});
test("mocked live CLI validates, writes, post-validates, and emits only sanitized summary", async () => {
  const { result } = await run(), approved = path.join(ROOT, "reports", "raw", "fast", gate.OUTPUT_BASENAME), stdout = []; let wrote = 0, postValidated = 0;
  const response = await gate.runCli(["--live-capture", "--output-dir", approved], {
    validateOutputPath: (value) => { assert.equal(value, approved); return approved; }, collect: async ({ onRpcStart }) => { onRpcStart(); return result; },
    write: (value, captured) => { assert.equal(value, approved); assert.equal(captured.bundle["limitations.json"].readOnlyLiveRpcCaptureStarted, true); assert.equal(captured.bundle["limitations.json"].readOnlyLiveRpcCaptureCompleted, true); validator.validateBundle(captured.bundle); wrote++; return validator.prepareBundle(captured.bundle).manifest; },
    confirmOwnership: () => true,
    postValidate: (value) => { assert.equal(value, approved); postValidated++; }, stdout: (text) => stdout.push(text), stderr: assert.fail, setExitCode: assert.fail,
  });
  assert.equal(response.ok, true); assert.equal(wrote, 1); assert.equal(postValidated, 1);
  const summary = JSON.parse(stdout[0]); assert.deepEqual(Object.keys(summary).sort(), ["blockHash", "blockNumber", "h3Decision", "independentFamilyCount", "terminal", "topology", "readOnlyLiveRpcCaptureStarted", "readOnlyLiveRpcCaptureCompleted", "wroteArtifacts"].sort());
  assert.equal(summary.wroteArtifacts, true); assert.equal(summary.independentFamilyCount, 2); assert.doesNotMatch(stdout[0], /https?:|example|invalid|secret|provider|domain/i);
});
test("mocked live CLI rejects overwrite before collection", async () => {
  const approved = path.join(ROOT, "reports", "raw", "fast", gate.OUTPUT_BASENAME), errors = []; let collected = false;
  await gate.runCli(["--live-capture", "--output-dir", approved], { validateOutputPath: () => { throw new gate.A4Error("lido-nest-a4-output-exists"); }, collect: async () => { collected = true; }, stderr: (text) => errors.push(text), stdout: assert.fail, setExitCode: () => {} });
  assert.equal(collected, false); const report = JSON.parse(errors[0]); assert.equal(report.readOnlyLiveRpcCaptureStarted, false); assert.equal(report.artifactAbsenceVerified, true); assert.equal(report.wroteArtifacts, false);
});
test("post-RPC failure reports started but incomplete capture without leaking errors", async () => {
  const approved = path.join(ROOT, "reports", "raw", "fast", gate.OUTPUT_BASENAME), errors = []; let wrote = false;
  await gate.runCli(["--live-capture", "--output-dir", approved], { validateOutputPath: () => approved, collect: async ({ onRpcStart }) => { onRpcStart(); throw new Error("https://secret-provider.invalid raw RPC"); }, write: () => { wrote = true; }, outputExists: () => false, stderr: (text) => errors.push(text), stdout: assert.fail, setExitCode: () => {} });
  assert.equal(wrote, false); const report = JSON.parse(errors[0]); assert.equal(report.readOnlyLiveRpcCaptureStarted, true); assert.equal(report.readOnlyLiveRpcCaptureCompleted, false); assert.equal(report.cleanupFailed, false); assert.equal(report.artifactAbsenceVerified, true); assert.equal(report.wroteArtifacts, false); assert.doesNotMatch(errors[0], /https?:|provider|raw RPC|secret/i);
});
test("every live capture phase emits only its exact bounded sanitized enum", async () => {
  const approved = path.join(ROOT, "reports", "raw", "fast", gate.OUTPUT_BASENAME), codes = Object.values(gate.PHASE_CODES);
  assert.equal(new Set(codes).size, 11);
  for (const expected of codes) {
    const authority = fixtureAuthority(), mocked = mock(authority), errors = []; let exitCode = 0;
    await gate.runCli(["--live-capture", "--output-dir", approved], {
      validateOutputPath: () => approved,
      collect: ({ onRpcStart }) => gate.runGate({ authority, candidates: candidates(), transport: mocked.transport, now: (() => { let value = 1000000; return () => value++; })(), onRpcStart, onPhase: (code) => { if (code === expected) throw new Error("https://private-provider.invalid raw RPC secret transport data"); } }),
      outputExists: () => false, stdout: assert.fail, stderr: (text) => errors.push(text), setExitCode: (code) => { exitCode = code; },
    });
    assert.equal(exitCode, 1); assert.equal(errors.length, 1); const report = JSON.parse(errors[0]);
    const expectedKeys = ["ok", "code", "readOnlyLiveRpcCaptureStarted", "readOnlyLiveRpcCaptureCompleted", "cleanupFailed", "artifactAbsenceVerified", "wroteArtifacts"];
    if (expected === gate.PHASE_CODES.inventoryQualification) expectedKeys.push("qualificationCounters");
    assert.deepEqual(Object.keys(report).sort(), expectedKeys.sort());
    assert.equal(report.code, expected); assert.equal(report.readOnlyLiveRpcCaptureStarted, expected !== gate.PHASE_CODES.inventoryQualification); assert.equal(report.readOnlyLiveRpcCaptureCompleted, false); assert.equal(report.cleanupFailed, false); assert.equal(report.artifactAbsenceVerified, true); assert.equal(report.wroteArtifacts, false);
    assert.doesNotMatch(errors[0], /https?:|provider|domain|explicit:|registrable:|mapped:|address|raw RPC|secret|private|0x[0-9a-f]{8}/i);
  }
});
test("qualification stage dropoffs emit only bounded aggregate counters", async () => {
  const approved = path.join(ROOT, "reports", "raw", "fast", gate.OUTPUT_BASENAME);
  const stages = [
    ["transport", (base) => async (candidate, method, params) => { if (method === "eth_chainId") throw new Error("https://private-provider.invalid transport secret"); return base(candidate, method, params); }, [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
    ["rpcError", (base) => async (candidate, method, params) => method === "eth_chainId" ? { error: { code: -1, message: "private provider error", data: "secret" } } : base(candidate, method, params), [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
    ["quantity", (base) => async (candidate, method, params) => method === "eth_chainId" ? "not-a-quantity-secret" : base(candidate, method, params), [2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0]],
    ["chainId", (base) => async (candidate, method, params) => method === "eth_chainId" ? "0x2" : base(candidate, method, params), [2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0]],
    ["finalized", (base) => async (candidate, method, params) => method === "eth_getBlockByNumber" && params[0] === "finalized" ? {} : base(candidate, method, params), [2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0]],
    ["runtime", (base, authority) => async (candidate, method, params) => method === "eth_getCode" && params[0].toLowerCase() === authority.addresses.executor ? "0x6001" : base(candidate, method, params), [2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0]],
    ["priceUnit", (base, authority) => async (candidate, method, params) => method === "eth_call" && params[0].to.toLowerCase() === authority.addresses.executor ? `0x${"00".repeat(32)}` : base(candidate, method, params), [2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0]],
    ["blockHash", (base) => async (candidate, method, params) => method === "eth_getBlockByHash" ? header(100, { stateRoot: `0x${"99".repeat(32)}` }) : base(candidate, method, params), [2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0]],
    ["families", (base) => base, [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1]],
  ];
  for (const [name, wrap, expected] of stages) {
    const authority = fixtureAuthority(), mocked = mock(authority), rows = candidates(), errors = [];
    if (name === "families") rows[1].family = rows[0].family;
    await gate.runCli(["--live-capture", "--output-dir", approved], { validateOutputPath: () => approved, collect: ({ onRpcStart }) => gate.runGate({ authority, candidates: rows, transport: wrap(mocked.transport, authority), onRpcStart }), outputExists: () => false, stdout: assert.fail, stderr: (text) => errors.push(text), setExitCode: () => {} });
    const report = JSON.parse(errors[0]), counters = report.qualificationCounters;
    assert.equal(report.code, gate.PHASE_CODES.inventoryQualification); assert.deepEqual(Object.keys(counters), gate.QUALIFICATION_COUNTER_KEYS);
    const stageKeys = ["candidatesAttempted", "chainIdTransportCompleted", "chainIdRpcResult", "chainIdQuantityValid", "chainId1", "finalizedHeaderValid", "executorRuntimeExact", "priceUnitExact", "blockHashRecheckExact", "qualifiedCount", "independentFamilyCount"];
    assert.deepEqual(stageKeys.map((key) => counters[key]), expected); assert.equal(counters.inventoryRecordsParsed, 2); assert.equal(counters.inventoryJsonRecordsParsed, 0); assert.equal(counters.inventoryLineRecordsParsed, 0);
    for (const value of Object.values(counters)) assert.ok(Number.isInteger(value) && value >= 0 && value <= gate.LIMITS.candidates);
    assert.doesNotMatch(JSON.stringify(report), /alpha|beta|example|invalid|explicit|family:|https?:|secret|provider|domain|authorization|x-key|0x[0-9a-f]{8}/i);
  }
});
test("six pre-chainId failures remain aggregate-only", async () => {
  const authority = fixtureAuthority(), errors = [], approved = path.join(ROOT, "reports", "raw", "fast", gate.OUTPUT_BASENAME);
  const rows = Array.from({ length: 6 }, (_, index) => ({ url: new URL(`https://private-${index}.example/rpc?secret=${index}`), headers: { Authorization: `secret-${index}` }, family: `explicit:private-${index}`, inventoryOrder: index, capabilityRank: index }));
  await gate.runCli(["--live-capture", "--output-dir", approved], { validateOutputPath: () => approved, collect: ({ onRpcStart }) => gate.runGate({ authority, candidates: rows, transport: async () => { throw new Error("private transport detail"); }, onRpcStart }), outputExists: () => false, stdout: assert.fail, stderr: (text) => errors.push(text), setExitCode: () => {} });
  const report = JSON.parse(errors[0]), counters = report.qualificationCounters;
  assert.equal(counters.inventoryRecordsParsed, 6); assert.equal(counters.candidatesAttempted, 6); assert.equal(counters.chainIdTransportCompleted, 0); assert.equal(counters.chainIdRpcResult, 0); assert.equal(counters.chainIdQuantityValid, 0); assert.equal(counters.chainId1, 0);
  assert.doesNotMatch(JSON.stringify(report), /private-|example|https?:|authorization|secret-|explicit:|transport detail/i);
});
test("inventory parser exposes format counts without inventory values", () => {
  const jsonCounts = {}, lineCounts = {};
  gate.parseInventoryText(JSON.stringify([{ chainId: 1, url: "https://json-secret.example/rpc?key=hidden" }]), jsonCounts);
  gate.parseInventoryText("ethereum chainId=1 https://line-secret.invalid/rpc?key=hidden", lineCounts);
  assert.deepEqual(jsonCounts, { inventoryJsonRecordsParsed: 1, inventoryRecordsParsed: 1 });
  assert.deepEqual(lineCounts, { inventoryLineRecordsParsed: 1, inventoryRecordsParsed: 1 });
  assert.doesNotMatch(JSON.stringify({ jsonCounts, lineCounts }), /json-secret|line-secret|example|invalid|https|hidden|rpc/i);
});
test("SIGINT after atomic write removes the actual output and verifies absence", async (t) => {
  const { result } = await run(), root = temporary(t), approved = path.join(root, "approved"), errors = []; let signal, exitCode = 0, postCalled = false;
  await gate.runCli(["--live-capture", "--output-dir", approved], { validateOutputPath: () => approved, installSignal: (handler) => { signal = handler; return () => {}; }, collect: async ({ onRpcStart }) => { onRpcStart(); return result; }, write: () => gate.atomicA4Bundle(approved, result.bundle), confirmOwnership: (directory, captured, receipt) => gate.confirmOutputOwnership(directory, captured, receipt, { allowTemporary: true }), afterOwnership: () => signal(), postValidate: () => { postCalled = true; }, stderr: (text) => errors.push(text), stdout: assert.fail, setExitCode: (code) => { exitCode = code; } });
  assert.equal(postCalled, false); assert.equal(fs.existsSync(approved), false); assert.equal(exitCode, 130);
  const report = JSON.parse(errors[0]); assert.equal(report.readOnlyLiveRpcCaptureStarted, true); assert.equal(report.readOnlyLiveRpcCaptureCompleted, true); assert.equal(report.cleanupFailed, false); assert.equal(report.artifactAbsenceVerified, true); assert.equal(report.wroteArtifacts, false);
});
test("cleanup failure reports unknown artifact state truthfully", async (t) => {
  const { result } = await run(), root = temporary(t), approved = path.join(root, "approved"), errors = []; let exitCode = 0;
  await gate.runCli(["--live-capture", "--output-dir", approved], { validateOutputPath: () => approved, collect: async ({ onRpcStart }) => { onRpcStart(); return result; }, write: () => { fs.mkdirSync(approved); return validator.prepareBundle(result.bundle).manifest; }, confirmOwnership: () => true, postValidate: () => { throw new Error("private transport failure"); }, removeOutput: () => { throw new Error("cleanup denied"); }, outputExists: () => true, stderr: (text) => errors.push(text), stdout: assert.fail, setExitCode: (code) => { exitCode = code; } });
  assert.equal(exitCode, 1); const report = JSON.parse(errors[0]); assert.equal(report.cleanupFailed, true); assert.equal(report.artifactAbsenceVerified, false); assert.equal(report.wroteArtifacts, "unknown"); assert.doesNotMatch(errors[0], /private|transport|cleanup denied/i);
});
test("generic atomic write failure never removes a concurrent foreign output", async (t) => {
  const { result } = await run(), root = temporary(t), approved = path.join(root, "approved"), errors = []; let removeCalled = false, confirmCalled = false;
  await gate.runCli(["--live-capture", "--output-dir", approved], { validateOutputPath: () => approved, collect: async ({ onRpcStart }) => { onRpcStart(); return result; }, write: () => { fs.mkdirSync(approved); fs.writeFileSync(path.join(approved, "foreign.txt"), "foreign-owner-content"); throw new Error("generic atomic rename failure"); }, confirmOwnership: () => { confirmCalled = true; return true; }, removeOutput: () => { removeCalled = true; }, stderr: (text) => errors.push(text), stdout: assert.fail, setExitCode: () => {} });
  assert.equal(confirmCalled, false); assert.equal(removeCalled, false); assert.equal(fs.readFileSync(path.join(approved, "foreign.txt"), "utf8"), "foreign-owner-content");
  const report = JSON.parse(errors[0]); assert.equal(report.cleanupFailed, false); assert.equal(report.artifactAbsenceVerified, false); assert.equal(report.wroteArtifacts, "unknown"); assert.doesNotMatch(errors[0], /rename|foreign-owner-content/i);
});
test("capability probe uses PRICE_UNIT with exact EIP-1898 and never empty calldata", async () => {
  const { authority, mocked } = await run();
  const priceData = authority.interfaces.executor.encodeFunctionData("PRICE_UNIT", []), probes = mocked.calls.filter((row) => row.method === "eth_call" && row.params[0].to === authority.addresses.executor && row.params[0].data === priceData);
  assert.ok(probes.length >= 2);
  assert.ok(probes.every((row) => row.params[1].requireCanonical === true));
  assert.equal(mocked.calls.some((row) => row.method === "eth_call" && row.params[0].data === "0x"), false);
  assert.equal(mocked.calls.some((row) => /sendTransaction|sendRawTransaction/i.test(row.method) || (row.method === "eth_call" && row.params.length !== 2)), false);
  assert.equal(mocked.calls.filter((row) => row.method === "eth_getCode" && row.params[0] === authority.addresses.executor).length >= 2, true);
  const rejected = await mocked.transport(candidates()[0], "eth_call", [{ to: authority.addresses.executor, data: "0x" }, { blockHash: `0x${"11".repeat(32)}`, requireCanonical: true }]);
  assert.equal(rejected.error.code, 3);
});
test("chainId qualification canonicalizes valid hex quantities including leading zero", async () => {
  const authority = fixtureAuthority(), mocked = mock(authority);
  const transport = async (candidate, method, params) => method === "eth_chainId" ? "0x01" : mocked.transport(candidate, method, params);
  const result = await gate.runGate({ authority, candidates: candidates(), transport, now: (() => { let value = 1000000; return () => value++; })() });
  assert.equal(result.bundle["authority.json"].chainIdAgreement, true);
  assert.ok(mocked.calls.some((row) => row.method === "eth_getBlockByNumber" && row.params[0] === "finalized"));
});
test("estimate errors distinguish unsupported block parameters, methods, and execution reverts", () => {
  assert.equal(gate.estimateError({ code: -32601, message: "method not found" }), "METHOD_UNSUPPORTED");
  assert.equal(gate.estimateError({ code: -32602, message: "block parameter unsupported" }), "BLOCK_PARAMETER_UNSUPPORTED");
  assert.equal(gate.estimateError({ code: 3, message: "execution reverted", data: "0x" }), "EXECUTION_REVERT");
});
test("estimate support failures remain scoped diagnostics and do not block valid state", async () => {
  const { result } = await run({ estimateError: { code: -32602, message: "block parameter unsupported" } });
  assert.ok(result.bundle["callability.json"].estimates.every((row) => row.status === "BLOCK_PARAMETER_UNSUPPORTED"));
  assert.equal(result.bundle["stage-a4-verdict.json"].terminal, "H3_BALANCED_IMMEDIATE_NEXT_BLOCK_GAS_FLOOR_EXCEEDS_GROSS");
});
test("immediate-next-block floor uses parent minus floor(parent/8), not an indefinite universal floor", () => {
  const row = gate.immediateNextBlockGas(15n, 100000000n, 8);
  assert.equal(row.parentBaseFeeReductionFloorWei, "1"); assert.equal(row.nextBaseFeeFloorWei, "14");
  assert.equal(row.immediateNextBlockGasFloorUsdWad, "294000");
});
test("family identity honors explicit metadata and aliases provider domains", () => {
  assert.equal(gate.providerFamily("tenant.alchemy.com"), gate.providerFamily("other.alchemyapi.io"));
  assert.equal(gate.providerFamily("tenant.alchemy.com", "spoofed-family"), "mapped:alchemy");
  assert.equal(gate.providerFamily("rpc.foo.co.uk"), "registrable:foo.co.uk");
  const rows = gate.parseInventoryText(JSON.stringify([{ chainId: 1, url: "https://a.example/rpc", family: "same" }, { chainId: 1, url: "https://b.invalid/rpc", providerFamily: "same" }]));
  assert.equal(rows[0].family, rows[1].family);
});
test("generic unlabeled HTTPS inventory is probed while obvious non-Ethereum entries are excluded", () => {
  const text = [
    "https://unlabeled.example/rpc [header: x-key=value] family=generic rank=7",
    "arbitrum mainnet https://arb.example/rpc",
    "https://solana.example/rpc solana",
    "sepolia https://test.example/rpc",
    "https://unlabeled.example/rpc [header: x-key=other] family=duplicate rank=9",
  ].join("\n"), rows = gate.parseInventoryText(text);
  assert.equal(rows.length, 1); assert.equal(rows[0].url.hostname, "unlabeled.example"); assert.equal(rows[0].headers["x-key"], "value"); assert.equal(rows[0].family, "explicit:generic"); assert.equal(rows[0].capabilityRank, 7);
  const json = gate.parseInventoryText(JSON.stringify([{ url: "https://generic.invalid/rpc", headers: { "x-key": "kept" }, family: "json-family", capabilityRank: 5 }, { url: "https://base.example/rpc", network: "base" }]));
  assert.equal(json.length, 1); assert.equal(json[0].headers["x-key"], "kept"); assert.equal(json[0].family, "explicit:json-family"); assert.equal(json[0].capabilityRank, 5);
});
test("stale early inventory rows cannot prevent two later independent full qualifications", async () => {
  const authority = fixtureAuthority(), mocked = mock(authority), calls = [];
  const rows = Array.from({ length: 12 }, (_, index) => ({ url: new URL(`https://candidate-${index}.example/rpc`), headers: {}, family: `explicit:family-${index}`, inventoryOrder: index, capabilityRank: index }));
  const transport = async (candidate, method, params) => { calls.push({ index: candidate.inventoryOrder, method }); if (method === "eth_chainId" && candidate.inventoryOrder < 10) return { error: { code: -1, message: "stale private endpoint" } }; return mocked.transport(candidate, method, params); };
  const result = await gate.runGate({ authority, candidates: rows, transport, now: (() => { let value = 1000000; return () => value++; })() });
  assert.equal(result.bundle["authority.json"].qualifiedIndependentFamilyCount, 2); assert.equal(calls.filter((row) => row.method === "eth_chainId").length, 12);
  assert.equal(calls.some((row) => row.index < 10 && row.method !== "eth_chainId"), false); assert.equal(calls.filter((row) => row.method === "eth_getBlockByNumber" && row.index >= 10).length >= 4, true);
});
test("chainId scan concurrency is bounded at eight", async () => {
  const authority = fixtureAuthority(), rows = Array.from({ length: 24 }, (_, index) => ({ url: new URL(`https://concurrency-${index}.example/rpc`), headers: {}, family: `explicit:c-${index}`, inventoryOrder: index, capabilityRank: 0 }));
  let active = 0, maximum = 0, error;
  try { await gate.runGate({ authority, candidates: rows, transport: async (_candidate, method) => { assert.equal(method, "eth_chainId"); active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 2)); active--; return "0x2"; } }); } catch (caught) { error = caught; }
  assert.equal(error.code, gate.PHASE_CODES.inventoryQualification); assert.equal(error.diagnostic.candidatesAttempted, 24); assert.equal(maximum, gate.LIMITS.chainIdConcurrency); assert.ok(maximum <= 8);
});
test("concurrent qualification reserves the global request budget before transport", async () => {
  const authority = fixtureAuthority(), mocked = mock(authority), rows = Array.from({ length: gate.LIMITS.candidates }, (_, index) => ({ url: new URL(`https://budget-${index}.example/rpc`), headers: {}, family: `explicit:b-${index}`, inventoryOrder: index, capabilityRank: index })); let transported = 0;
  await assert.rejects(() => gate.runGate({ authority, candidates: rows, transport: async (candidate, method, params) => { transported++; return mocked.transport(candidate, method, params); }, now: (() => { let value = 1000000; return () => value++; })() }), /BLOCKED_A4_GRAPH_GETTERS/);
  assert.equal(transported, gate.LIMITS.requests);
});
test("RPC inventory file is canonical, regular, bounded, non-symlink, and mutation checked", (t) => {
  const directory = temporary(t), valid = path.join(directory, "inventory.txt"); fs.writeFileSync(valid, "mainnet chainId=1 https://example.invalid/rpc\n");
  assert.match(gate.readInventoryFile(valid), /mainnet/);
  const empty = path.join(directory, "empty.txt"); fs.writeFileSync(empty, ""); assert.throws(() => gate.readInventoryFile(empty), /inventory-file-invalid/);
  const oversized = path.join(directory, "oversized.txt"); fs.writeFileSync(oversized, Buffer.alloc(gate.LIMITS.inventoryBytes + 1, 1)); assert.throws(() => gate.readInventoryFile(oversized), /inventory-file-invalid/);
  assert.throws(() => gate.readInventoryFile(directory), /inventory-file-invalid/);
  const mutable = path.join(directory, "mutable.txt"); fs.writeFileSync(mutable, "mainnet"); assert.throws(() => gate.readInventoryFile(mutable, { afterRead: () => fs.appendFileSync(mutable, "x") }), /inventory-file-mutated/);
  const link = path.join(directory, "link.txt");
  try { fs.symlinkSync(valid, link); assert.throws(() => gate.readInventoryFile(link), /inventory-file-invalid/); } catch (error) { if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error; }
});
test("capability and premium suitability rank before latency, then families diversify", () => {
  const selected = gate.selectTwo([
    { candidate: { family: "a", capabilityRank: 1, inventoryOrder: 0 }, latency: 1 },
    { candidate: { family: "b", capabilityRank: 9, inventoryOrder: 1 }, latency: 100 },
    { candidate: { family: "c", capabilityRank: 8, inventoryOrder: 2 }, latency: 200 },
  ]);
  assert.deepEqual(selected.map((row) => row.candidate.family), ["b", "c"]);
});
test("NONEMPTY requires supply, D, both balances positive, and exact actual balances", () => {
  assert.equal(gate.classifyTopology({ totalSupply: 1n, D: 1n, balance0: 1n, balance1: 1n, actual0: 1n, actual1: 1n }), "NONEMPTY");
  assert.equal(gate.classifyTopology({ totalSupply: 1n, D: 1n, balance0: 1n, balance1: 0n, actual0: 1n, actual1: 0n }), "INCONSISTENT");
});
test("valid empty state and successful call close exact H3 only by immediate-next-block gas", async () => {
  const { result } = await run(), verdict = result.bundle["stage-a4-verdict.json"];
  assert.equal(verdict.terminal, "H3_BALANCED_IMMEDIATE_NEXT_BLOCK_GAS_FLOOR_EXCEEDS_GROSS");
  assert.equal(verdict.exactH3CandidateRoutePositive, false); assert.equal(verdict.routePositive, "unknown");
});
test("valid low-gas state escalates exact H3 with unknown flags", async () => {
  const { result } = await run({ baseFee: "0x1", answer: 1n }), verdict = result.bundle["stage-a4-verdict.json"], stonks = result.bundle["current-state.json"].stonks;
  assert.equal(verdict.terminal, "ESCALATE_H3_PINNED_FORK"); assert.equal(verdict.exactH3CandidateRoutePositive, "unknown"); assert.equal(verdict.routePositive, "unknown");
  assert.equal(stonks.orderDurationFromTuple, "1800"); assert.equal(stonks.durationGetter, "1800"); assert.equal(stonks.exact, true);
});
test("technical runtime block remains unknown when no independent closure exists", async () => {
  const { result } = await run({ runtimeMismatch: "math", baseFee: "0x1", answer: 1n }), verdict = result.bundle["stage-a4-verdict.json"];
  assert.equal(verdict.terminal, "BLOCKED_CURRENT_RUNTIME_CONTINUITY"); assert.equal(verdict.exactH3CandidateRoutePositive, "unknown");
});
test("consistent recognized revert closes current H3 callability", async () => {
  const { result } = await run({ revert: "0x01584009" }), call = result.bundle["callability.json"], verdict = result.bundle["stage-a4-verdict.json"];
  assert.equal(call.callConsistent, true); assert.equal(call.callSucceeded, false); assert.equal(call.outcome.category, "NotInLpMode"); assert.equal(call.outcome.decodedExact, true);
  assert.equal(verdict.terminal, "H3_BALANCED_CURRENTLY_UNREACHABLE_NotInLpMode"); assert.equal(verdict.exactH3CandidateRoutePositive, false);
  assert.throws(() => validator.validateBundle({ ...result.bundle, "callability.json": { ...call, outcome: { ...call.outcome, name: "Invented", category: "Invented" } } }), /callability-invalid/);
});
test("revert decoding requires complete pinned-ABI payloads and exact paused string", () => {
  const authority = fixtureAuthority(), iface = authority.interfaces.executor;
  const custom = iface.encodeErrorResult("DepositValueBelowMinimum", [1n, 2n]);
  assert.deepEqual(gate.decodeRevert(custom, iface), { decodedExact: true, closureEligible: true, kind: "CUSTOM_ERROR", name: "DepositValueBelowMinimum", category: "DepositValueBelowMinimum" });
  assert.equal(gate.decodeRevert(custom.slice(0, -2), iface).decodedExact, false);
  assert.equal(gate.decodeRevert("0x01584009ff", iface).decodedExact, false);
  assert.equal(gate.decodeRevert("0x015840", iface).decodedExact, false);
  const errorPayload = (message) => `0x08c379a0${AbiCoder.defaultAbiCoder().encode(["string"], [message]).slice(2)}`;
  assert.deepEqual(gate.decodeRevert(errorPayload("Pausable: paused"), iface), { decodedExact: true, closureEligible: true, kind: "ERROR_STRING", name: "Error", message: "Pausable: paused", category: "PAUSED" });
  const unrelatedString = gate.decodeRevert(errorPayload("paused"), iface); assert.equal(unrelatedString.decodedExact, true); assert.equal(unrelatedString.closureEligible, false);
});
test("only exact addLiquidity-reachable source errors are closure eligible", async () => {
  const authority = fixtureAuthority(), iface = authority.interfaces.executor;
  const allowed = {
    NotInLpMode: [], ZeroLdoBalance: [], ZeroStEthBalance: [], OraclePriceUnavailable: [], InvalidOraclePrice: [],
    PoolPriceDivergenceTooHigh: [1n, 2n, 3n, 4n], DepositValueBelowMinimum: [1n, 2n],
  };
  for (const [name, args] of Object.entries(allowed)) {
    assert.ok(iface.getError(name), name); const decoded = gate.decodeRevert(iface.encodeErrorResult(name, args), iface);
    assert.equal(decoded.decodedExact, true, name); assert.equal(decoded.closureEligible, true, name); assert.equal(decoded.name, name);
  }
  for (const [name, args] of [["InvalidAdminAddress", []], ["InsufficientLpTokenBalance", [1n, 2n]], ["InvalidStonksAddress", []]]) {
    const decoded = gate.decodeRevert(iface.encodeErrorResult(name, args), iface); assert.equal(decoded.decodedExact, true, name); assert.equal(decoded.closureEligible, false, name);
  }
  const unrelated = iface.encodeErrorResult("InvalidAdminAddress", []), verdict = (await run({ revert: unrelated, baseFee: "0x1", answer: 1n })).result.bundle["stage-a4-verdict.json"];
  assert.equal(verdict.terminal, "BLOCKED_CURRENT_CALLABILITY_UNKNOWN_REVERT"); assert.equal(verdict.exactH3CandidateRoutePositive, "unknown");
});
test("independent revert closure survives bad Stonks and stale oracle", async () => {
  const { result } = await run({ revert: "0x01584009", badStonks: "runtime", startedAt: 1n, updatedAt: 1n }), verdict = result.bundle["stage-a4-verdict.json"];
  assert.equal(verdict.terminal, "H3_BALANCED_CURRENTLY_UNREACHABLE_NotInLpMode");
  assert.deepEqual(verdict.independentH3Closures, ["H3_BALANCED_CURRENTLY_UNREACHABLE_NotInLpMode"]);
});
test("independent NONEMPTY closure survives stale oracle and bad Stonks", async () => {
  const { result } = await run({ nonempty: true, badStonks: "runtime", startedAt: 1n, updatedAt: 1n }), verdict = result.bundle["stage-a4-verdict.json"];
  assert.equal(verdict.terminal, "H3_BALANCED_CURRENTLY_UNREACHABLE_NONEMPTY_POOL");
  assert.deepEqual(verdict.independentH3Closures, ["H3_BALANCED_CURRENTLY_UNREACHABLE_NONEMPTY_POOL"]);
});
test("consistent empty revert remains a technical unknown", async () => {
  const { result } = await run({ revert: "0x", baseFee: "0x1", answer: 1n }), verdict = result.bundle["stage-a4-verdict.json"];
  assert.equal(verdict.terminal, "BLOCKED_CURRENT_CALLABILITY_UNKNOWN_REVERT"); assert.equal(verdict.exactH3CandidateRoutePositive, "unknown");
});
test("provider/canAddLiquidity disagreement blocks", async () => {
  const { result } = await run({ revert: "0x01584009", canAddLiquidity: true, baseFee: "0x1", answer: 1n }), verdict = result.bundle["stage-a4-verdict.json"];
  assert.equal(verdict.terminal, "BLOCKED_CURRENT_CALL_RESULT_DISAGREEMENT"); assert.equal(verdict.exactH3CandidateRoutePositive, "unknown");
});
test("nonempty pool closes exact H3 and one-zero-balance pool is inconsistent", async () => {
  const nonempty = (await run({ nonempty: true })).result.bundle["stage-a4-verdict.json"];
  assert.equal(nonempty.terminal, "H3_BALANCED_CURRENTLY_UNREACHABLE_NONEMPTY_POOL"); assert.equal(nonempty.exactH3CandidateRoutePositive, false);
  const oneZero = (await run({ oneZero: true, baseFee: "0x1", answer: 1n })).result;
  assert.equal(oneZero.bundle["current-state.json"].pool.topology, "INCONSISTENT"); assert.equal(oneZero.bundle["stage-a4-verdict.json"].terminal, "BLOCKED_CURRENT_POOL_TOPOLOGY");
});
test("LP mode requires exact nonzero A1-bound Stonks configuration", async () => {
  for (const badStonks of ["zero", "runtime", "receiver", "manager", "tokens", "duration", "tupleDuration"]) {
    const verdict = (await run({ badStonks, baseFee: "0x1", answer: 1n })).result.bundle["stage-a4-verdict.json"];
    assert.equal(verdict.terminal, "BLOCKED_CURRENT_STONKS_CONTINUITY", badStonks); assert.equal(verdict.exactH3CandidateRoutePositive, "unknown");
  }
});
test("non-LP zero Stonks is scoped out, while artifact address syntax and equality are mandatory", async () => {
  const { result } = await run({ lpModeEnabled: false, badStonks: "zero", baseFee: "0x1", answer: 1n }), state = result.bundle["current-state.json"];
  assert.equal(state.stonks.required, false); assert.equal(state.stonks.address, ZERO); assert.equal(state.stonks.exact, true);
  assert.equal(result.bundle["stage-a4-verdict.json"].terminal, "ESCALATE_H3_PINNED_FORK");
  assert.throws(() => validator.validateBundle({ ...result.bundle, "current-state.json": { ...state, stonks: { ...state.stonks, address: "not-an-address" } } }), /stonks-invalid/);
  assert.throws(() => validator.validateBundle({ ...result.bundle, "current-state.json": { ...state, stonks: { ...state.stonks, address: `0x${"12".repeat(20)}` } } }), /stonks-invalid/);
  assert.throws(() => validator.validateBundle({ ...result.bundle, "current-state.json": { ...state, executor: { ...state.executor, stonks: `0x${"34".repeat(20)}` } } }), /stonks-invalid/);
});
for (const [name, change, reason] of [
  ["zero feed", { zeroFeed: true }, "ZERO_FEED"], ["empty feed code", { emptyFeedCode: true }, "EMPTY_FEED_CODE"],
  ["oversize feed code", { oversizeFeedCode: true }, "FEED_CODE_OVERSIZE"], ["bad decimals", { decimals: 19 }, "DECIMALS_OUT_OF_RANGE"],
  ["zero round", { roundId: 0n }, "ROUND_ID_ZERO"], ["zero startedAt", { startedAt: 0n }, "STARTED_AT_ZERO"],
  ["updated before started", { startedAt: 99950n, updatedAt: 99900n }, "UPDATED_BEFORE_STARTED"], ["future update", { updatedAt: 100001n }, "UPDATED_IN_FUTURE"],
  ["stale update", { startedAt: 1n, updatedAt: 1n }, "STALE"], ["old answered round", { roundId: 2n, answeredInRound: 1n }, "ANSWERED_IN_ROUND_OLD"],
]) test(`Chainlink ${name} blocks with sanitized recomputable facts`, async () => {
  const { result } = await run(change), economics = result.bundle["economics-screen.json"], verdict = result.bundle["stage-a4-verdict.json"];
  assert.ok(economics.oracle.reasons.includes(reason)); assert.equal(economics.immediateNextBlock, null);
  assert.equal(verdict.terminal, "BLOCKED_CURRENT_ORACLE_VALIDITY"); assert.equal(verdict.exactH3CandidateRoutePositive, "unknown");
});
test("dual finalized header disagreement fails closed", async () => {
  const authority = fixtureAuthority(), rows = candidates(); rows[1].badHeader = true; const mocked = mock(authority);
  await assert.rejects(() => gate.runGate({ authority, candidates: rows, transport: mocked.transport }), /BLOCKED_A4_COMMON_HEADER_CONSENSUS/);
});
test("selector commitment is derived from pinned ABI and validator rejects tampering", async () => {
  const { result } = await run(), authority = result.bundle["authority.json"];
  assert.equal(authority.selectors["executor.PRICE_UNIT()"], id("PRICE_UNIT()").slice(0, 10));
  assert.throws(() => validator.validateBundle({ ...result.bundle, "authority.json": { ...authority, selectorCommitmentSha256: "0".repeat(64) } }), /selector-invalid/);
});
test("validator recomputes topology, TVL, callability, Stonks, oracle, gas, decisions, and nonclaims", async () => {
  const { result } = await run(), bundle = result.bundle;
  assert.throws(() => validator.validateBundle({ ...bundle, "authority.json": { ...bundle["authority.json"], a3Semantics: { ...bundle["authority.json"].a3Semantics, candidate: "wrong" } } }), /authority-invalid/);
  assert.throws(() => validator.validateBundle({ ...bundle, "authority.json": { ...bundle["authority.json"], targets: { ...bundle["authority.json"].targets, executor: { ...bundle["authority.json"].targets.executor, bundle: { bytes: 1, sha256: "0".repeat(64) } } } } }), /authority-invalid/);
  assert.throws(() => validator.validateBundle({ ...bundle, "current-state.json": { ...bundle["current-state.json"], pool: { ...bundle["current-state.json"].pool, topology: "NONEMPTY" } } }), /topology-invalid/);
  assert.throws(() => validator.validateBundle({ ...bundle, "current-state.json": { ...bundle["current-state.json"], tvl: { ...bundle["current-state.json"].tvl, poolTvlUsdWad: "1" } } }), /tvl-invalid/);
  assert.throws(() => validator.validateBundle({ ...bundle, "current-state.json": { ...bundle["current-state.json"], stonks: { ...bundle["current-state.json"].stonks, duration: "1" } } }), /stonks-invalid/);
  assert.throws(() => validator.validateBundle({ ...bundle, "callability.json": { ...bundle["callability.json"], callSucceeded: false } }), /callability-invalid/);
  assert.throws(() => validator.validateBundle({ ...bundle, "economics-screen.json": { ...bundle["economics-screen.json"], oracle: { ...bundle["economics-screen.json"].oracle, updatedAt: "0" } } }), /oracle-invalid/);
  assert.throws(() => validator.validateBundle({ ...bundle, "economics-screen.json": { ...bundle["economics-screen.json"], immediateNextBlock: { ...bundle["economics-screen.json"].immediateNextBlock, nextBaseFeeFloorWei: "1" } } }), /economics-invalid/);
  assert.throws(() => validator.validateBundle({ ...bundle, "stage-a4-verdict.json": { ...bundle["stage-a4-verdict.json"], routePositive: false } }), /verdict-invalid/);
});
test("validator fails closed on empty authorities, headers, schemas, extras, max age, omissions, and nonclaims", async () => {
  const { result } = await run(), b = result.bundle, mutate = (name, value) => ({ ...b, [name]: value });
  assert.throws(() => validator.validateBundle(mutate("authority.json", { ...b["authority.json"], programs: {} })), /authority-invalid/);
  assert.throws(() => validator.validateBundle(mutate("authority.json", { ...b["authority.json"], targets: {} })), /authority-invalid/);
  assert.throws(() => validator.validateBundle(mutate("runtime-continuity.json", { ...b["runtime-continuity.json"], runtimes: {} })), /runtime-invalid/);
  assert.throws(() => validator.validateBundle(mutate("runtime-continuity.json", { ...b["runtime-continuity.json"], graph: {} })), /runtime-invalid/);
  for (const field of ["parentHash", "stateRoot", "timestamp", "baseFeePerGas", "gasLimit", "gasUsed"]) {
    const pin = { ...b["block-pin.json"] }; delete pin[field]; assert.throws(() => validator.validateBundle(mutate("block-pin.json", pin)), /pin-invalid/);
  }
  assert.throws(() => validator.validateBundle(mutate("block-pin.json", { ...b["block-pin.json"], gasUsed: (BigInt(b["block-pin.json"].gasLimit) + 1n).toString() })), /pin-invalid/);
  assert.throws(() => validator.validateBundle(mutate("economics-screen.json", { ...b["economics-screen.json"], oracle: { ...b["economics-screen.json"].oracle, maxAgeSeconds: 1 } })), /oracle-invalid/);
  assert.throws(() => validator.validateBundle(mutate("economics-screen.json", { ...b["economics-screen.json"], omitsPriorityFee: false })), /economics-invalid/);
  assert.throws(() => validator.validateBundle(mutate("economics-screen.json", { ...b["economics-screen.json"], omitsSeedAddRemoveAcquisitionUnwind: false })), /economics-invalid/);
  assert.throws(() => validator.validateBundle(mutate("limitations.json", { ...b["limitations.json"], liquidExitEstablished: true })), /limitations-invalid/);
  assert.throws(() => validator.validateBundle(mutate("limitations.json", { ...b["limitations.json"], acquisitionRouteEstablished: true })), /limitations-invalid/);
  assert.throws(() => validator.validateBundle(mutate("stage-a4-verdict.json", { ...b["stage-a4-verdict.json"], schemaVersion: 1 })), /schema-invalid/);
  assert.throws(() => validator.validateBundle(mutate("callability.json", { ...b["callability.json"], unexpected: false })), /callability-invalid/);
  assert.throws(() => validator.validateBundle({ ...b, "extra.json": {} }), /bundle-invalid/);
});
test("target bundle mutation fails exact A1/A2 binding", { skip: PROGRAM_PINS.pending }, (t) => {
  const pre = gate.productionPreflight(), directory = temporary(t);
  for (const pin of Object.values(TARGET_PINS)) fs.copyFileSync(path.join(TARGET_ROOT, pin.filename), path.join(directory, pin.filename));
  fs.appendFileSync(path.join(directory, TARGET_PINS.executor.filename), " ");
  assert.throws(() => gate.bindTargets(pre.pubs.a1, pre.pubs.a2, directory), /target-pin-mismatch/);
});
test("A2 binding requires every direct, pool, immutable-tail, and blueprint truth flag", { skip: PROGRAM_PINS.pending }, () => {
  const pre = gate.productionPreflight(), clone = (value) => JSON.parse(JSON.stringify(value));
  const cases = [
    (a2) => { a2.files["curve-direct-bindings.json"].rows[0].explorerBytecodeBundleExact = false; },
    (a2) => { a2.files["pool-immutable-binding.json"].compiledRuntimeExactPrefix = false; },
    (a2) => { a2.files["pool-immutable-binding.json"].compiledCreationPlusConstructorExact = false; },
    (a2) => { a2.files["pool-immutable-binding.json"].explorerCreationInputExact = false; },
    (a2) => { a2.files["pool-immutable-binding.json"].immutableTail.reconstructedFromDecodedConstructorFactoryDeploymentAndChainId = false; },
    (a2) => { a2.files["pool-blueprint-binding.json"].blueprintRuntimeEqualsPrefixPlusCompiledCreation = false; },
    (a2) => { a2.files["pool-blueprint-binding.json"].deploymentWrapperExact = false; },
  ];
  for (const change of cases) { const a2 = clone(pre.pubs.a2); change(a2); assert.throws(() => gate.bindTargets(pre.pubs.a1, a2), /target-a2-mismatch/); }
});
test("aggregate CAP is enforced before writing", async (t) => {
  const { result } = await run(), directory = temporary(t), output = path.join(directory, "bundle");
  result.bundle["callability.json"].estimates[0].gasUnits = "9".repeat(gate.CAP);
  assert.throws(() => gate.atomicA4Bundle(output, result.bundle), /artifact-cap/); assert.equal(fs.existsSync(output), false);
});
test("atomic output is canonical, no-replace, exact-allowlist, false-durability, and tamper evident", async (t) => {
  const { result } = await run(), directory = temporary(t), output = path.join(directory, "bundle"), rollback = path.join(directory, "rollback");
  assert.throws(() => gate.atomicA4Bundle(rollback, result.bundle, () => { throw new Error("pre-rename"); }), /pre-rename/); assert.equal(fs.existsSync(rollback), false);
  gate.atomicA4Bundle(output, result.bundle); assert.equal(validator.validateDirectory(output, { allowTemporary: true }), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"))); assert.equal(manifest.durabilityClaimed, false);
  assert.throws(() => gate.atomicA4Bundle(output, result.bundle), /output-exists/);
  fs.writeFileSync(path.join(output, "extra.json"), "{}\n"); assert.throws(() => validator.validateDirectory(output, { allowTemporary: true }), /allowlist-invalid/);
});
test("validator rejects durability overclaim and symlink files when supported", async (t) => {
  const { result } = await run(), directory = temporary(t), output = path.join(directory, "bundle"); gate.atomicA4Bundle(output, result.bundle);
  const manifestPath = path.join(output, "manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestPath)); manifest.durabilityClaimed = true; fs.writeFileSync(manifestPath, `${validator.canonical(manifest)}\n`);
  assert.throws(() => validator.validateDirectory(output, { allowTemporary: true }), /manifest-invalid/);
  try { fs.rmSync(path.join(output, "authority.json")); fs.symlinkSync(path.join(output, "block-pin.json"), path.join(output, "authority.json")); assert.throws(() => validator.validateDirectory(output, { allowTemporary: true }), /directory-invalid/); } catch (error) { if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error; }
});
test("production output policy rejects path escape, arbitrary parents, protected paths, and wrong basename", () => {
  assert.throws(() => gate.validateOutputPath(path.join(ROOT, "tools", gate.OUTPUT_BASENAME)), /output-path|parent-invalid/);
  assert.throws(() => gate.validateOutputPath(path.join(ROOT, "reports", "raw", "fast", "wrong")), /output-path/);
  assert.throws(() => gate.validateOutputPath(path.join(ROOT, "reports", "raw", "fast", gate.OUTPUT_BASENAME, "escape")), /output-path|parent-invalid/);
});
test("program snapshots reject a direct test mutation", { skip: PROGRAM_PINS.pending }, (t) => {
  const directory = temporary(t), testFile = path.join(directory, "stage-a4.test.js"); fs.copyFileSync(__filename, testFile); fs.appendFileSync(testFile, " ");
  assert.throws(() => gate.snapshotPrograms(path.join(ROOT, "tools", "atomic", "lido-nest-bootstrap-gate4"), testFile), /program-pin-mismatch/);
});
