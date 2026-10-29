"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { snapshotDirectory } = require("../atomic/ethereum-top-trades-7d-reconstruction/deep-reconstruct");
const { sanitizeBlock, sanitizeReceipt, sanitizeTransaction } = require("../atomic/ethereum-top-trades-7d-reconstruction/forensics");
const { canonicalInclusion, TARGET_HASH } = require("../atomic/ethereum-top-trades-7d-reconstruction/morpho-funded-arbitrage-trace-verifier");
const { ADDRESSES, LIMITS, READ_ONLY_METHODS, STAGE2A_SCHEMA_VERSION, STAGE2A_TIER, TARGETS, assertStage1Unchanged, nativeLedger, requiredRuntimeUniverse, runtimeBind, validateLimits, verifyStage1Directory } = require("../atomic/ethereum-top-trades-7d-reconstruction/morpho-funded-arbitrage-runtime-binder");
const { atomicBundle } = require("../atomic/ethereum-top-trades-7d-reconstruction/output");
const { argumentsOf, atomicWriteOptions, safeTerminalCode } = require("../atomic/ethereum-top-trades-7d-reconstruction/run");

const ACTOR = "0xd7e1236c08731c3632519dcd1a581bfe6876a3b2";
const FEE = "0x396343362be2a4da1ce0c1c210945346fb82aa49";
const BLOCK = "0x4d2a6d6004e9abc844ef774a38a5622a5f0f28691856e679f9b373475f4c1796";
const PARENT = `0x${"a".repeat(64)}`;
const INPUT = "0x12345678aabb";
const PRECOMPILE_IDENTITY = "0x0000000000000000000000000000000000000004";
const EXTRA_EXECUTED_CONTEXT = "0x1234567890abcdef1234567890abcdef12345678";

function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function commitment(value) { return `0x${crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`; }
function bytesHash(value) { return `0x${crypto.createHash("sha256").update(Buffer.from(value.slice(2), "hex")).digest("hex")}`; }
function full(value) { return `0x${value.repeat(64).slice(0, 64)}`; }
function word(value) { return `0x${BigInt(value).toString(16).padStart(64, "0")}`; }
function addressWord(value) { return `0x${"0".repeat(24)}${value.slice(2)}`; }
function abiString(value) { const bytes = Buffer.from(value); const padded = Math.ceil(bytes.length / 32) * 64; return `0x${(32n).toString(16).padStart(64, "0")}${BigInt(bytes.length).toString(16).padStart(64, "0")}${bytes.toString("hex").padEnd(padded, "0")}`; }
function serializer(transaction, target) { return { bytes: "0x02aabb", hash: target, from: transaction.from }; }

function rawObjects() {
  return {
    transaction: { hash: TARGET_HASH, blockHash: BLOCK, blockNumber: "0x1896ecb", transactionIndex: "0x3", from: ACTOR, to: ADDRESSES.executor, value: `0x${1787080631n.toString(16)}`, type: "0x2", nonce: "0x1", gas: "0x1", maxFeePerGas: `0x${110271844n.toString(16)}`, maxPriorityFeePerGas: "0x0", chainId: "0x1", v: "0x1", r: full("2"), s: full("3"), accessList: [], input: INPUT },
    receipt: { transactionHash: TARGET_HASH, blockHash: BLOCK, blockNumber: "0x1896ecb", transactionIndex: "0x3", from: ACTOR, to: ADDRESSES.executor, status: "0x1", gasUsed: `0x${401832n.toString(16)}`, effectiveGasPrice: `0x${110271844n.toString(16)}`, cumulativeGasUsed: "0x1", logsBloom: `0x${"0".repeat(512)}`, type: "0x2", logs: [] },
    block: { hash: BLOCK, parentHash: PARENT, number: "0x1896ecb", timestamp: `0x${1787080631n.toString(16)}`, miner: FEE, sha3Uncles: full("4"), stateRoot: full("5"), transactionsRoot: full("6"), receiptsRoot: full("7"), logsBloom: `0x${"0".repeat(512)}`, difficulty: "0x0", gasLimit: "0x1", gasUsed: "0x1", extraData: "0x", mixHash: full("8"), nonce: "0x0000000000000000", baseFeePerGas: `0x${110271844n.toString(16)}`, transactions: [full("9"), full("a"), full("b"), TARGET_HASH] },
  };
}

function stage1Bundle(corrupt = false, extraCodeContext = null) {
  const raw = rawObjects(); const transaction = sanitizeTransaction(raw.transaction); const receipt = sanitizeReceipt(raw.receipt); const block = sanitizeBlock(raw.block);
  const inclusion = canonicalInclusion(raw, { transaction }, serializer).persisted;
  const frames = [
    { frameCommitmentSha256: full("1"), type: "CALL", storageContext: ADDRESSES.executor, codeContext: ADDRESSES.executor, calleeContext: ADDRESSES.executor, effectiveStatus: "SUCCEEDED", inputSha256: bytesHash(INPUT) },
    { frameCommitmentSha256: full("2"), type: "DELEGATECALL", storageContext: ADDRESSES.executor, codeContext: ADDRESSES.executorDelegate, calleeContext: ADDRESSES.executorDelegate, effectiveStatus: "SUCCEEDED" },
    { frameCommitmentSha256: full("3"), type: "DELEGATECALL", storageContext: ADDRESSES.usdc, codeContext: ADDRESSES.usdcImplementation, calleeContext: ADDRESSES.usdcImplementation, effectiveStatus: "SUCCEEDED" },
    { frameCommitmentSha256: full("4"), type: "DELEGATECALL", storageContext: ADDRESSES.apxUsd, codeContext: ADDRESSES.apxUsdImplementation, calleeContext: ADDRESSES.apxUsdImplementation, effectiveStatus: "SUCCEEDED" },
    { frameCommitmentSha256: full("5"), type: "STATICCALL", storageContext: ADDRESSES.apxUsdHelper, codeContext: ADDRESSES.apxUsdHelper, calleeContext: ADDRESSES.apxUsdHelper, effectiveStatus: "SUCCEEDED" },
    { frameCommitmentSha256: full("6"), type: "STATICCALL", storageContext: PRECOMPILE_IDENTITY, codeContext: PRECOMPILE_IDENTITY, calleeContext: PRECOMPILE_IDENTITY, effectiveStatus: "SUCCEEDED" },
  ];
  if (extraCodeContext) frames.push({ frameCommitmentSha256: full("7"), type: "CALL", storageContext: extraCodeContext, codeContext: extraCodeContext, calleeContext: extraCodeContext, effectiveStatus: "SUCCEEDED" });
  const frameHashes = frames.map((row) => row.frameCommitmentSha256); const logHashes = [];
  const traceCommitmentSha256 = corrupt ? full("f") : commitment(frameHashes);
  const closureRows = [...TARGETS.map(([address, role]) => ({ address, roles: [role] })), { address: PRECOMPILE_IDENTITY, roles: ["precompile"] }];
  if (extraCodeContext) closureRows.push({ address: extraCodeContext, roles: ["extra-executed-code-context"] });
  const traceProjection = { transactionHash: TARGET_HASH, addressClosure: { cap: 64, count: closureRows.length, rows: closureRows }, trace: { frameCount: frames.length, frames, nativeTransfers: [
    { from: ACTOR, to: ADDRESSES.executor, amountWei: "1787080631", type: "CALL", path: "0" },
    { from: ADDRESSES.weth, to: ADDRESSES.executor, amountWei: "130190489338729", type: "CALL", path: "0.1" },
    { from: ADDRESSES.executor, to: FEE, amountWei: "49926140511081", type: "CALL", path: "0.2" },
    { from: ADDRESSES.executor, to: ACTOR, amountWei: "80264348827648", type: "CALL", path: "0.3" },
  ], rootBindingComplete: true, rootInputCommitmentMatched: true, traceCommitmentSha256 } };
  const canonicalEvidence = { transaction, receipt: { ...receipt, logs: undefined }, block, inclusion, logs: [], logsCommitmentSha256: commitment(logHashes), canonicalAgreement: { canonicalInclusionMatched: true, normalizedCallTraceCommitmentsMatched: true } };
  delete canonicalEvidence.receipt.logs;
  return {
    "source-binding.json": { immutable: true, selectedHash: TARGET_HASH },
    "canonical-evidence.json": canonicalEvidence,
    "trace-projection.json": traceProjection,
    "arithmetic-fixture.json": { transactionGas: { exactGasWei: "44310755618208" } },
    "stage1-verdict.json": { terminalStage: "REJECTED_INCOMPLETE_TRANSACTION_LOCAL_VECTOR" },
    "runtime.json": { mode: "fixture" },
  };
}

function makeStage1(parent, corrupt = false, extraCodeContext = null) {
  const directory = path.join(parent, "synthetic-stage1"); atomicBundle(directory, stage1Bundle(corrupt, extraCodeContext));
  return { directory, expectations: { expectedBasename: "synthetic-stage1", expectedManifestSha256: snapshotDirectory(directory)["manifest.json"].sha256 } };
}

function inventory(shared = false) { return [0, 1].map((index) => ({ url: `http://localhost:${9900 + index}`, lineIndex: index, ethereumHint: true, unsupportedMode: false, declaredGroup: true, groupIdentity: shared ? "same" : Symbol(`family-${index}`) })); }
function prestate(options, provider) {
  const rows = {};
  for (let index = 0; index < TARGETS.length; index += 1) { const [address] = TARGETS[index]; rows[address] = { code: `0x60${(index + 1).toString(16).padStart(2, "0")}` }; }
  for (const target of options.extraRuntime || []) rows[target] = { code: "0x60fe" };
  if (options.missingRuntime) delete rows[ADDRESSES.executorDelegate];
  if (options.familyMismatch && provider.ordinal === "provider-02") rows[ADDRESSES.executorDelegate].code = "0x6000";
  return rows;
}
function mockTransport(options = {}) {
  const raw = rawObjects();
  return async ({ provider, method, params }) => {
    let result;
    if (method === "eth_chainId") result = "0x1";
    else if (method === "eth_getTransactionByHash") result = structuredClone(raw.transaction);
    else if (method === "eth_getTransactionReceipt") result = structuredClone(raw.receipt);
    else if (method === "eth_getBlockByHash") result = structuredClone(raw.block);
    else if (method === "debug_traceTransaction") {
      result = prestate(options, provider);
      if (options.oversizedPrestate) return { result, bytes: LIMITS.responseBytes + 1 };
    } else if (method === "eth_call") {
      const { to, data } = params[0]; const selector = data.slice(0, 10);
      if (to === ADDRESSES.v3Pool) {
        const values = { "0xc45a0155": addressWord(full("1").slice(0, 42)), "0x0dfe1681": addressWord(ADDRESSES.usdc), "0xd21220a7": addressWord(ADDRESSES.weth), "0xddca3f43": word(3000), "0xd0c93a7c": word(60), "0x70cf754a": word(1000000) }; result = values[selector];
      } else if (to === ADDRESSES.curvePool) result = addressWord(data.endsWith("0".repeat(64)) ? ADDRESSES.apxUsd : ADDRESSES.usdc);
      else if (selector === "0x313ce567") result = word(to === ADDRESSES.usdc ? 6 : 18);
      else if (selector === "0x06fdde03") result = abiString(options.leakMetadata ? "https://forbidden.invalid" : "Token");
      else if (selector === "0x95d89b41") result = abiString("TOK");
      else throw new Error("unexpected-call");
    } else throw new Error("unexpected-method");
    return { result, bytes: Buffer.byteLength(JSON.stringify(result)) };
  };
}
function options(made, extra = {}) { return { sourceDirectory: made.directory, stage1Expectations: made.expectations, inventoryEntries: inventory(), transport: mockTransport(), type2Serializer: serializer, ...extra }; }

test("Stage2A CLI mode is explicit and source-only", () => {
  assert.equal(argumentsOf(["--morpho-funded-arbitrage-runtime-binder", "--source-dir", "source"]).mode, "morpho-stage2a");
  assert.throws(() => argumentsOf(["--morpho-funded-arbitrage-runtime-binder"]), /requires-source/);
  assert.throws(() => argumentsOf(["--morpho-funded-arbitrage-runtime-binder", "--source-dir", "source", "--hash", TARGET_HASH]), /rejects-other-mode-options/);
  assert.equal(safeTerminalCode(new Error("stage2a-stage1-commitment-mismatch")), "stage2a-stage1-commitment-mismatch");
  assert.equal([...READ_ONLY_METHODS].some((method) => /send|sign|code|storage/i.test(method)), false);
});

test("the fixed successful Stage1 artifact validates offline and remains immutable", () => {
  const sourcePath = path.join(__dirname, "..", "..", "reports", "raw", "fast", "atomic-ethereum-top-trades-7d-reconstruction", "morpho-stage1-2026-08-26T02-25-32-196Z-8e901119");
  const source = verifyStage1Directory(sourcePath); const universe = requiredRuntimeUniverse(source); assert.doesNotThrow(() => assertStage1Unchanged(source));
  assert.ok(universe.rows.some((row) => row.address === ADDRESSES.universalRouter && row.role === "universal-router"));
  assert.ok(universe.rows.some((row) => row.address === PRECOMPILE_IDENTITY && row.precompile === true));
});

test("Stage2A success binds two-family prestate runtimes and remains mandatorily nonpromotable", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2a-success-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const made = makeStage1(parent);
  const result = await runtimeBind(options(made)); const verdict = result.bundle["stage2a-verdict.json"];
  assert.equal(verdict.schemaVersion, STAGE2A_SCHEMA_VERSION); assert.equal(verdict.evidenceTier, STAGE2A_TIER); assert.match(verdict.evidenceTier, /R2_V2$/);
  assert.equal(verdict.runtimePrestateExact, true); assert.equal(verdict.blockPoststateConfigResponsesExact, true); assert.equal(verdict.transactionPrestateConfigExact, false); assert.equal(verdict.standardConfigExact, false); assert.equal(verdict.nativeLedgerExact, true);
  assert.equal(verdict.perAddressAssetVectorExact, false); assert.equal(verdict.controlledClusterExact, false); assert.equal(verdict.scalarHistoricalNetExact, false); assert.equal(verdict.routePositive, "unknown"); assert.equal(verdict.currentExecutable, false); assert.equal(verdict.promotable, false);
  const runtime = result.bundle["runtime-bindings.json"]; assert.equal(runtime.rows.length, requiredRuntimeUniverse(verifyStage1Directory(made.directory, made.expectations)).rows.length); assert.equal(runtime.rawBytecodePersisted, false); assert.equal(runtime.requiredUniverse.derivedFromEverySuccessfulFrameCodeContext, true);
  assert.equal(runtime.rows.find((row) => row.address === PRECOMPILE_IDENTITY).binding, "standard-ethereum-precompile");
  assert.equal(result.bundle["configuration-bindings.json"].viewPosition, "canonical-block-poststate"); assert.equal(result.bundle["configuration-bindings.json"].transactionPrestateConfigExact, false);
  assert.equal(JSON.stringify(result.bundle).includes("0x6001"), false);
  const output = path.join(parent, "stage2a"); atomicBundle(output, result.bundle, atomicWriteOptions("morpho-stage2a", result));
  assert.deepEqual(fs.readdirSync(output).sort(), ["configuration-bindings.json", "manifest.json", "native-ledger.json", "runtime-bindings.json", "stage1-anchor.json", "stage2a-verdict.json"]);
});

test("runtime closure discovers successful code contexts outside named TARGETS and fails closed when absent", async (t) => {
  assert.equal(TARGETS.some(([target]) => target === EXTRA_EXECUTED_CONTEXT), false);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2a-dynamic-runtime-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const made = makeStage1(parent, false, EXTRA_EXECUTED_CONTEXT);
  const exact = await runtimeBind(options(made, { transport: mockTransport({ extraRuntime: [EXTRA_EXECUTED_CONTEXT] }) })); const exactRow = exact.bundle["runtime-bindings.json"].rows.find((row) => row.address === EXTRA_EXECUTED_CONTEXT);
  assert.equal(exactRow.role, "executed-code-context"); assert.equal(exactRow.binding, "transaction-prestate"); assert.equal(exact.bundle["stage2a-verdict.json"].runtimePrestateExact, true);
  const missing = await runtimeBind(options(made)); const missingRow = missing.bundle["runtime-bindings.json"].rows.find((row) => row.address === EXTRA_EXECUTED_CONTEXT);
  assert.equal(missingRow.binding, "unknown"); assert.equal(missing.bundle["stage2a-verdict.json"].runtimePrestateExact, false); assert.equal(missing.bundle["stage2a-verdict.json"].promotable, false);
});

test("family mismatch fails closed without sanitized output", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2a-family-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const made = makeStage1(parent);
  await assert.rejects(() => runtimeBind(options(made, { transport: mockTransport({ familyMismatch: true }) })), /two-independent-runtime-agreement-unavailable/);
  await assert.rejects(() => runtimeBind(options(made, { inventoryEntries: inventory(true) })), /two-independent-runtime-agreement-unavailable/);
});

test("Stage1 commitment mismatch is rejected before provider work", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2a-anchor-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const made = makeStage1(parent, true); let calls = 0;
  await assert.rejects(() => runtimeBind(options(made, { transport: async () => { calls += 1; throw new Error("must-not-run"); } })), /stage1-commitment-mismatch/); assert.equal(calls, 0);
});

test("missing runtime is explicitly unknown and cannot promote", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2a-missing-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const made = makeStage1(parent);
  const result = await runtimeBind(options(made, { transport: mockTransport({ missingRuntime: true }) }));
  assert.equal(result.bundle["stage2a-verdict.json"].runtimePrestateExact, false); assert.equal(result.bundle["stage2a-verdict.json"].terminalStage, "REJECTED_UNKNOWN_RUNTIME"); assert.equal(result.bundle["stage2a-verdict.json"].routePositive, "unknown");
  assert.equal(result.bundle["runtime-bindings.json"].rows.find((row) => row.address === ADDRESSES.executorDelegate).binding, "unknown");
});

test("oversized prestate response and unsupported semantics fail with fixed bounded errors", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2a-prestate-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const made = makeStage1(parent);
  await assert.rejects(() => runtimeBind(options(made, { transport: mockTransport({ oversizedPrestate: true }) })), /response-budget-exceeded/);
  const base = mockTransport(); const unsupported = async (request) => request.method === "debug_traceTransaction" ? { result: { pre: {}, post: {} }, bytes: 20 } : base(request);
  await assert.rejects(() => runtimeBind(options(made, { transport: unsupported })), /unsupported-prestate-semantics/);
});

test("provider-controlled metadata leakage is rejected before artifact writing", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2a-leak-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const made = makeStage1(parent);
  await assert.rejects(() => runtimeBind(options(made, { transport: mockTransport({ leakMetadata: true }) })), /output-leak-scan:url/);
});

test("native ledger keeps signer, executor, fee recipient, WETH, gas, and root value separate", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2a-ledger-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const made = makeStage1(parent); const source = verifyStage1Directory(made.directory, made.expectations); const ledger = nativeLedger(source, rawObjects().block);
  assert.equal(ledger.signerAndExecutorAggregated, false); assert.equal(ledger.rootValueWei, "1787080631"); assert.equal(ledger.gasWei, "44310755618208"); assert.equal(ledger.priorityFeeWei, "0"); assert.equal(ledger.baseFeeBurnWei, "44310755618208"); assert.equal(ledger.conservation.agrees, true); assert.equal(ledger.proposerPaymentIdentityRequired, false);
  const signer = ledger.rows.find((row) => row.role === "signer"); const executor = ledger.rows.find((row) => row.role === "executor");
  assert.equal(signer.callFlowDeltaWei, "80262561747017"); assert.equal(signer.transactionLocalDeltaWei, "35951806128809"); assert.equal(executor.transactionLocalDeltaWei, "1787080631");
});

test("type-2 native ledger allocates nonzero priority fee and base-fee burn exactly", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stage2a-type2-ledger-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true })); const made = makeStage1(parent); const source = verifyStage1Directory(made.directory, made.expectations);
  const gasUsed = 21000n; const baseFeePerGas = 100000000000n; const maxPriorityFeePerGas = 2000000000n; const maxFeePerGas = 150000000000n; const effectiveGasPrice = baseFeePerGas + maxPriorityFeePerGas; const gasWei = gasUsed * effectiveGasPrice;
  assert.equal(source.canonicalEvidence.transaction.type, "2"); assert.ok(effectiveGasPrice <= maxFeePerGas);
  source.canonicalEvidence.receipt.gasUsed = gasUsed.toString(); source.canonicalEvidence.receipt.effectiveGasPrice = effectiveGasPrice.toString(); source.fixture.transactionGas.exactGasWei = gasWei.toString();
  const ledger = nativeLedger(source, { baseFeePerGas: `0x${baseFeePerGas.toString(16)}` }); const feeRecipient = ledger.rows.find((row) => row.role === "fee-recipient");
  assert.equal(ledger.gasWei, "2142000000000000"); assert.equal(ledger.priorityFeeWei, "42000000000000"); assert.equal(ledger.baseFeeBurnWei, "2100000000000000");
  assert.equal(feeRecipient.gasDeltaWei, "42000000000000"); assert.equal(feeRecipient.transactionLocalDeltaWei, "91926140511081");
  assert.equal(ledger.conservation.addressDeltaSumWei, "-2100000000000000"); assert.equal(ledger.conservation.expectedBaseFeeBurnWei, "-2100000000000000"); assert.equal(ledger.conservation.agrees, true);
});

test("all Stage2A limits reject unknown, nonfinite, fractional, negative, and over-cap overrides", () => {
  assert.deepEqual(validateLimits({}), LIMITS);
  for (const field of Object.keys(LIMITS)) for (const value of [NaN, Infinity, 1.5, -1]) assert.throws(() => validateLimits({ [field]: value }), /invalid-limits/);
  for (const row of [{ unknown: 1 }, { requests: 161 }, { responseBytes: 16777217 }, { totalResponseBytes: 134217729 }, { totalTimeoutMs: 300001 }, { requestTimeoutMs: 8001 }, { outputBytes: 2097153 }, { providerCap: 6 }, { traceRequestCap: 6 }, { traceConcurrency: 2, concurrency: 1 }]) assert.throws(() => validateLimits(row), /invalid-limits/);
});
