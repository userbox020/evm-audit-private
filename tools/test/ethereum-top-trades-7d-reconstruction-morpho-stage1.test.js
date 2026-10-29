"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { TRANSFER_TOPIC, WETH_WITHDRAWAL_TOPIC } = require("../atomic/ethereum-top-trades-7d-reconstruction/constants");
const { assertSourceUnchanged, snapshotDirectory } = require("../atomic/ethereum-top-trades-7d-reconstruction/deep-reconstruct");
const { sanitizeBlock, sanitizeReceipt, sanitizeTransaction } = require("../atomic/ethereum-top-trades-7d-reconstruction/forensics");
const {
  STAGE1_LIMITS,
  TARGET_HASH,
  buildAddressClosure,
  buildArithmeticFixture,
  morphoFundedArbitrageTraceVerifier,
  normalizeCallTrace,
  normalizedEventLogs,
  validateLimits,
} = require("../atomic/ethereum-top-trades-7d-reconstruction/morpho-funded-arbitrage-trace-verifier");
const { atomicBundle, leakScan } = require("../atomic/ethereum-top-trades-7d-reconstruction/output");
const { argumentsOf, atomicWriteOptions, safeTerminalCode } = require("../atomic/ethereum-top-trades-7d-reconstruction/run");

const ACTOR = "0xd7e1236c08731c3632519dcd1a581bfe6876a3b2";
const EXECUTOR = "0x06cff7088619c7178f5e14f0b119458d08d2f5ef";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const LENDER = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const V4 = "0x000000000004444c5dc75cb358380d2e3de08a90";
const V3 = "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8";
const CURVE = "0x6f63deedc9870d6c16fc644c6654748352cdc87c";
const APX = "0x98a878b1cd98131b271883b390f68d2c90674665";
const FEE_RECIPIENT = "0x396343362be2a4da1ce0c1c210945346fb82aa49";
const BLOCK_HASH = "0x4d2a6d6004e9abc844ef774a38a5622a5f0f28691856e679f9b373475f4c1796";
const PARENT_HASH = `0x${"a".repeat(64)}`;
const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

function padded(address) { return `0x${"0".repeat(24)}${address.slice(2)}`; }
function word(value) { return BigInt(value).toString(16).padStart(64, "0"); }
function rawLog(index, address, topics, data = "0x") {
  return { address, blockHash: BLOCK_HASH, blockNumber: "0x1896ecb", transactionHash: TARGET_HASH, transactionIndex: "0x3", logIndex: `0x${index.toString(16)}`, removed: false, topics, data };
}
function transfer(index, token, from, to, amount) { return rawLog(index, token, [TRANSFER_TOPIC, padded(from), padded(to)], `0x${word(amount)}`); }

function rawObjects() {
  const logs = [
    rawLog(13, LENDER, [`0x${"1".repeat(64)}`, padded(EXECUTOR), padded(USDC)], `0x${word(7)}`),
    transfer(14, USDC, LENDER, EXECUTOR, 158249999),
    transfer(16, USDC, EXECUTOR, V4, 158249999),
    transfer(19, USDC, CURVE, EXECUTOR, 158500142),
    transfer(21, WETH, V3, EXECUTOR, 130190489338729n),
    transfer(22, USDC, EXECUTOR, V3, 250143),
    rawLog(23, V3, [V3_SWAP_TOPIC, padded(EXECUTOR), padded(EXECUTOR)], `0x${word(250143)}${word(-130190489338729n & ((1n << 256n) - 1n))}${word(1n << 96n)}${word(1000)}${word(0)}`),
    rawLog(24, WETH, [WETH_WITHDRAWAL_TOPIC, padded(EXECUTOR)], `0x${word(130190489338729n)}`),
    transfer(25, USDC, EXECUTOR, LENDER, 158249999),
  ];
  return {
    transaction: { hash: TARGET_HASH, blockHash: BLOCK_HASH, blockNumber: "0x1896ecb", transactionIndex: "0x3", from: ACTOR, to: EXECUTOR, value: `0x${1787080631n.toString(16)}`, type: "0x2", nonce: "0x1", gas: "0x90000", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1", chainId: "0x1", v: "0x1", r: `0x${"2".repeat(64)}`, s: `0x${"3".repeat(64)}`, input: "0x12345678aabb" },
    receipt: { transactionHash: TARGET_HASH, blockHash: BLOCK_HASH, blockNumber: "0x1896ecb", transactionIndex: "0x3", from: ACTOR, to: EXECUTOR, status: "0x1", gasUsed: `0x${401832n.toString(16)}`, effectiveGasPrice: `0x${110271844n.toString(16)}`, cumulativeGasUsed: "0x1", logsBloom: `0x${"0".repeat(512)}`, type: "0x2", logs },
    block: { hash: BLOCK_HASH, parentHash: PARENT_HASH, number: "0x1896ecb", timestamp: `0x${1787080631n.toString(16)}`, miner: FEE_RECIPIENT, sha3Uncles: `0x${"4".repeat(64)}`, stateRoot: `0x${"5".repeat(64)}`, transactionsRoot: `0x${"6".repeat(64)}`, receiptsRoot: `0x${"7".repeat(64)}`, logsBloom: `0x${"0".repeat(512)}`, difficulty: "0x0", gasLimit: "0x1", gasUsed: "0x1", extraData: "0x", mixHash: `0x${"8".repeat(64)}`, nonce: "0x0000000000000000", baseFeePerGas: "0x1", transactions: [`0x${"9".repeat(64)}`, `0x${"a".repeat(64)}`, `0x${"b".repeat(64)}`, TARGET_HASH] },
  };
}

function sourceObjects() {
  const raw = rawObjects();
  const window = { chainId: "1", immutable: true, predecessorBoundary: { number: "25783843", hash: `0x${"b".repeat(64)}`, timestamp: "1787078603" }, start: { number: "25783844", hash: `0x${"c".repeat(64)}`, timestamp: "1787078615" }, finalized: { number: "25834079", hash: `0x${"d".repeat(64)}`, timestamp: "1787683415" } };
  return { raw, window, row: { transaction: sanitizeTransaction(raw.transaction), receipt: sanitizeReceipt(raw.receipt), block: sanitizeBlock(raw.block) } };
}

function makeSource(parent) {
  const source = sourceObjects(); const directory = path.join(parent, "source");
  atomicBundle(directory, { "window.json": source.window, "candidates.json": { sampleKind: "BOUNDED_EVENT_SAMPLE_V1", rows: [source.row] } });
  return { ...source, directory };
}

function inventory(count = 2, shared = false) {
  const identities = Array.from({ length: count }, (_, index) => shared ? "same" : Symbol(`family-${index}`));
  return identities.map((groupIdentity, index) => ({ url: `http://localhost:${9000 + index}`, lineIndex: index, ethereumHint: true, unsupportedMode: false, declaredGroup: true, groupIdentity }));
}

function trace(nativeBinding = false) {
  const frame = (row) => ({ gas: "0x100", gasUsed: "0x10", ...row });
  return {
    ...frame({ type: "CALL", from: ACTOR, to: EXECUTOR, value: `0x${1787080631n.toString(16)}`, input: "0x12345678aabb", output: "0x01" }), calls: [
      frame({ type: "DELEGATECALL", from: EXECUTOR, to: V4, value: "0x0", input: "0xaabbccdd0011", output: "0x00" }),
      ...(nativeBinding ? [frame({ type: "CALL", from: EXECUTOR, to: WETH, value: "0x0", input: "0x", output: "0x", calls: [frame({ type: "CALL", from: WETH, to: EXECUTOR, value: `0x${130190489338729n.toString(16)}`, input: "0x", output: "0x" })] })] : []),
      frame({ type: "STATICCALL", from: EXECUTOR, to: APX, value: "0x0", input: "0x01020304", output: "0xaabb" }),
      frame({ type: "CALL", from: EXECUTOR, to: CURVE, value: "0x5", input: "0x", output: "0x", error: "execution reverted", calls: [frame({ type: "CALL", from: CURVE, to: FEE_RECIPIENT, value: "0x5", input: "0x", output: "0x" })] }),
    ],
  };
}

function mockType2Serializer(transaction, target) { return { bytes: "0x02aabb", hash: target, from: transaction.from }; }
function verifierOptions(made, extra = {}) { return { sourceDirectory: made.directory, hash: TARGET_HASH, inventoryEntries: inventory(), transport: transport(made), type2Serializer: mockType2Serializer, ...extra }; }

function transport(made, options = {}) {
  return async ({ provider, method, params }) => {
    let result;
    if (method === "eth_chainId") result = "0x1";
    else if (method === "eth_getBlockByNumber") {
      const number = BigInt(params[0]).toString();
      const boundary = [made.window.predecessorBoundary, made.window.start, made.window.finalized].find((row) => row.number === number);
      result = { number: `0x${BigInt(boundary.number).toString(16)}`, hash: boundary.hash, timestamp: `0x${BigInt(boundary.timestamp).toString(16)}` };
    } else if (method === "eth_getTransactionByHash") result = structuredClone(made.raw.transaction);
    else if (method === "eth_getTransactionReceipt") {
      result = structuredClone(made.raw.receipt);
      if (options.logVariant && provider.ordinal === options.logVariant) result.logs[0].data = `0x${word(8)}`;
    } else if (method === "eth_getBlockByHash") {
      result = structuredClone(made.raw.block);
      if (options.inclusionVariant && provider.ordinal === options.inclusionVariant) result.transactions[3] = `0x${"e".repeat(64)}`;
    }
    else if (method === "debug_traceTransaction") {
      result = trace(options.nativeBinding === true);
      if (options.traceVariant && provider.ordinal === options.traceVariant) result.calls[0].to = CURVE;
      if (options.inputVariant && provider.ordinal === options.inputVariant) result.calls[0].input = "0xaabbccdd0022";
      if (options.outputVariant && provider.ordinal === options.outputVariant) result.calls[0].output = "0x01";
      if (options.gasVariant && provider.ordinal === options.gasVariant) result.calls[0].gasUsed = "0x11";
      if (options.mutateSource) fs.appendFileSync(path.join(made.directory, "candidates.json"), " ");
    } else throw new Error("unexpected-method");
    return { result, bytes: Buffer.byteLength(JSON.stringify(result)) };
  };
}

test("Stage 1 CLI mode is explicit, source-bound, and rejects ambiguity", () => {
  const parsed = argumentsOf(["--morpho-funded-arbitrage-trace-verifier", "--source-dir", "source", "--hash", TARGET_HASH]);
  assert.equal(parsed.mode, "morpho-stage1");
  assert.throws(() => argumentsOf(["--morpho-funded-arbitrage-trace-verifier", "--source-dir", "source"]), /requires-source-and-hash/);
  assert.throws(() => argumentsOf(["--morpho-funded-arbitrage-trace-verifier", "--source-dir", "source", "--hash", TARGET_HASH, "--no-write"]), /rejects-other-mode-options/);
  assert.throws(() => argumentsOf(["--collect", "--morpho-funded-arbitrage-trace-verifier", "--source-dir", "source", "--hash", TARGET_HASH]), /choose-exactly-one-mode/);
  assert.throws(() => argumentsOf(["--morpho-funded-arbitrage-trace-verifier", "--source-dir", "source", "--source-dir", "other", "--hash", TARGET_HASH]), /duplicate-source-directory-option/);
  assert.throws(() => argumentsOf(["--morpho-funded-arbitrage-trace-verifier", "--source-dir", "source", "--hash", TARGET_HASH, "--hash", TARGET_HASH]), /duplicate-transaction-hash-option/);
  for (const code of ["stage1-exact-target-hash-required", "stage1-address-closure-cap-exceeded", "stage1-two-independent-canonical-trace-providers-unavailable"]) assert.equal(safeTerminalCode(new Error(code)), code);
});

test("trace normalization binds root, contexts, lengths, revert propagation, and closure roles", () => {
  const made = sourceObjects();
  const rawTrace = trace(true);
  rawTrace.calls.push({ type: "CREATE2", from: EXECUTOR, to: "0x1111111111111111111111111111111111111111", value: "0x2", input: "0xaabb", output: "0x", gas: "0x100", gasUsed: "0x10" });
  rawTrace.calls.push({ type: "SELFDESTRUCT", from: EXECUTOR, to: FEE_RECIPIENT, value: "0x3", input: "0x", output: "0x", gas: "0x100", gasUsed: "0x10" });
  const normalized = normalizeCallTrace(rawTrace, made.row.transaction, made.row.receipt, STAGE1_LIMITS, made.raw.transaction.input);
  assert.equal(normalized.frames[0].selector, "0x12345678");
  assert.equal(normalized.frames[0].inputLengthBytes, 6);
  assert.equal(normalized.frames[0].outputLengthBytes, 1);
  assert.match(normalized.frames[0].inputSha256, /^0x[0-9a-f]{64}$/);
  assert.match(normalized.frames[0].outputSha256, /^0x[0-9a-f]{64}$/);
  assert.equal(normalized.frames[0].gas, "256");
  assert.equal(normalized.frames[0].gasUsed, "16");
  assert.equal(normalized.frames[1].storageContext, EXECUTOR);
  assert.equal(normalized.frames.find((row) => row.path === "0.3.0").effectiveStatus, "REVERTED");
  assert.equal(normalized.nativeTransfers.some((row) => row.path === "0.3.0"), false);
  const closure = buildAddressClosure(made.row.transaction, normalized);
  assert.ok(closure.rows.find((row) => row.address === V4).roles.includes("delegate-code:0.0"));
  assert.ok(closure.rows.find((row) => row.address === APX).roles.includes("staticcall-target:0.2"));
  assert.ok(closure.rows.find((row) => row.address === CURVE).roles.includes("call-target:0.3"));
  assert.ok(closure.rows.find((row) => row.address === FEE_RECIPIENT).roles.includes("selfdestruct-beneficiary:0.5"));
  assert.equal(JSON.stringify(normalized).includes("12345678aabb"), false);
});

test("trace normalization rejects unknown creation semantics and address closure overflow", () => {
  const made = sourceObjects();
  const badCreate = trace(); badCreate.calls.push({ type: "CREATE", from: EXECUTOR, value: "0x0", input: "0x", output: "0x", gas: "0x1", gasUsed: "0x0" });
  assert.throws(() => normalizeCallTrace(badCreate, made.row.transaction, made.row.receipt, STAGE1_LIMITS, made.raw.transaction.input), /unknown-creation-or-selfdestruct-semantics/);
  const normalized = normalizeCallTrace(trace(true), made.row.transaction, made.row.receipt, STAGE1_LIMITS, made.raw.transaction.input);
  assert.throws(() => buildAddressClosure(made.row.transaction, normalized, 2), /address-closure-cap-exceeded/);
});

test("trace tree validation rejects commitment, caller, value, quantity, and type ambiguity", () => {
  const made = sourceObjects();
  const normalize = (value) => normalizeCallTrace(value, made.row.transaction, made.row.receipt, STAGE1_LIMITS, made.raw.transaction.input);
  const wrongInput = trace(); wrongInput.input = "0x12345678aabc";
  assert.throws(() => normalize(wrongInput), /root-binding-mismatch/);
  const wrongCaller = trace(); wrongCaller.calls[0].from = ACTOR;
  assert.throws(() => normalize(wrongCaller), /child-caller-context-mismatch/);
  const staticValue = trace(); staticValue.calls[1].value = "0x1";
  assert.throws(() => normalize(staticValue), /zero-value-call-type-violation/);
  const delegateValue = trace(); delegateValue.calls[0].value = "0x1";
  assert.throws(() => normalize(delegateValue), /zero-value-call-type-violation/);
  const noncanonicalGas = trace(); noncanonicalGas.calls[0].gas = "0x0100";
  assert.throws(() => normalize(noncanonicalGas), /noncanonical-trace-gas/);
  const unknown = trace(); unknown.calls[0].type = "MAGICCALL";
  assert.throws(() => normalize(unknown), /unsupported-call-type/);

  const callcode = trace(); callcode.calls[0] = { type: "CALLCODE", from: EXECUTOR, to: V4, value: "0x2", input: "0x", output: "0x", gas: "0x1", gasUsed: "0x1" };
  const projected = normalize(callcode).frames[1];
  assert.equal(projected.storageContext, EXECUTOR);
  assert.equal(projected.codeContext, V4);
  assert.equal(projected.type, "CALLCODE");
});

test("the 64-address cap covers all ordinary executed call targets and contexts", () => {
  const made = sourceObjects(); const raw = trace(); raw.calls = [];
  for (let index = 1; index <= 65; index += 1) raw.calls.push({ type: index % 2 ? "CALL" : "STATICCALL", from: EXECUTOR, to: `0x${index.toString(16).padStart(40, "0")}`, value: "0x0", input: "0x", output: "0x", gas: "0x1", gasUsed: "0x1" });
  const normalized = normalizeCallTrace(raw, made.row.transaction, made.row.receipt, STAGE1_LIMITS, made.raw.transaction.input);
  assert.throws(() => buildAddressClosure(made.row.transaction, normalized, 64), /address-closure-cap-exceeded/);
});

test("event projection decodes authoritative layouts but leaves unknown logs position-bound and count-only", () => {
  const events = normalizedEventLogs(rawObjects().receipt);
  const unknown = events.find((row) => row.position === "13");
  assert.equal(unknown.position, "13");
  assert.equal(unknown.emitter, LENDER);
  assert.equal(unknown.topicCount, 3);
  assert.equal(unknown.decoded, null);
  assert.match(unknown.rawLogCommitmentSha256, /^0x[0-9a-f]{64}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(unknown, "topics"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(unknown, "data"), false);
  assert.equal(events.find((row) => row.position === "14").decoded.amount, "158249999");
  assert.equal(events.find((row) => row.position === "23").decoded.kind, "uniswap-v3-swap");
  assert.equal(events.find((row) => row.position === "24").decoded.kind, "withdrawal");
});

test("arithmetic fixture binds the exact USDC equation and gas without inventing a profit scalar", () => {
  const made = sourceObjects(); const normalized = normalizeCallTrace(trace(false), made.row.transaction, made.row.receipt, STAGE1_LIMITS, made.raw.transaction.input); const events = normalizedEventLogs(made.raw.receipt);
  const fixture = buildArithmeticFixture(made.row, normalized, events);
  assert.equal(fixture.usdcConservation.exactEquation, "158249999+158500142=158249999+250143+158249999");
  assert.equal(fixture.transactionGas.exactGasWei, "44310755618208");
  assert.equal(fixture.wethNativeBinding.complete, false);
  const altered = structuredClone(made.row); altered.receipt.gasUsed = "401831";
  assert.throws(() => buildArithmeticFixture(altered, normalized, events), /gas-fixture-mismatch/);
  assert.doesNotMatch(JSON.stringify(fixture), /"(?:profit|net|usdMicros|priceUsd)"/i);
});

test("WETH completeness requires exact singleton transfer, withdrawal, and successful native payout", () => {
  const made = sourceObjects(); const normalized = normalizeCallTrace(trace(true), made.row.transaction, made.row.receipt, STAGE1_LIMITS, made.raw.transaction.input); const events = normalizedEventLogs(made.raw.receipt);
  assert.equal(buildArithmeticFixture(made.row, normalized, events).wethNativeBinding.complete, true);
  const extraTransfer = structuredClone(events.find((row) => row.position === "21")); extraTransfer.position = "26";
  assert.equal(buildArithmeticFixture(made.row, normalized, [...events, extraTransfer]).wethNativeBinding.complete, false);
  const extraWithdrawal = structuredClone(events.find((row) => row.position === "24")); extraWithdrawal.position = "27";
  assert.equal(buildArithmeticFixture(made.row, normalized, [...events, extraWithdrawal]).wethNativeBinding.complete, false);
  const extraNative = structuredClone(normalized); extraNative.nativeTransfers.push({ ...extraNative.nativeTransfers.find((row) => row.from === WETH), path: "0.9" });
  assert.equal(buildArithmeticFixture(made.row, extraNative, events).wethNativeBinding.complete, false);
});

test("bounded verifier requires two independent exact providers and emits a mandatory incomplete-vector rejection", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-stage1-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const made = makeSource(parent); const before = snapshotDirectory(made.directory);
  const result = await morphoFundedArbitrageTraceVerifier(verifierOptions(made));
  assert.deepEqual(snapshotDirectory(made.directory), before);
  assert.doesNotThrow(() => assertSourceUnchanged(result.source));
  assert.doesNotThrow(() => leakScan(result.bundle));
  const verdict = result.bundle["stage1-verdict.json"];
  assert.equal(verdict.terminalStage, "REJECTED_INCOMPLETE_TRANSACTION_LOCAL_VECTOR");
  assert.equal(verdict.exactOnchainTransactionNet, "unknown");
  assert.equal(verdict.routePositive, "unknown");
  assert.equal(verdict.currentExecutable, false);
  assert.equal(verdict.promotable, false);
  assert.ok(verdict.missingVectors.includes("apxusd-plus-one-raw-unit-valuation-unproven"));
  assert.ok(verdict.missingVectors.includes("weth-withdrawal-to-native-transfer-binding-unproven"));
  assert.deepEqual(result.bundle["canonical-evidence.json"].canonicalAgreement.providers, ["provider-01", "provider-02"]);
  assert.equal(result.bundle["canonical-evidence.json"].inclusion.targetAtExactTransactionIndex, true);
  assert.equal(result.bundle["canonical-evidence.json"].inclusion.signedType2BytesHashVerified, true);
  assert.match(result.bundle["canonical-evidence.json"].inclusion.transactionListCommitmentSha256, /^0x[0-9a-f]{64}$/);
  assert.match(result.bundle["canonical-evidence.json"].logsCommitmentSha256, /^0x[0-9a-f]{64}$/);
  assert.match(result.bundle["trace-projection.json"].trace.traceCommitmentSha256, /^0x[0-9a-f]{64}$/);
  assert.equal(result.bundle["runtime.json"].budgets.requestCap, 240);
  assert.equal(result.bundle["runtime.json"].budgets.traceRequestCap, 6);
  assert.equal(result.bundle["runtime.json"].budgets.outputBytesUsed < 2 * 1024 * 1024, true);
  assert.doesNotMatch(JSON.stringify(result.bundle), /12345678aabb|https?:\/\//i);
  assert.equal(JSON.stringify(result.bundle).includes(`0x${"9".repeat(64)}`), false);

  const output = path.join(parent, "output"); atomicBundle(output, result.bundle);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")).endpointFree, true);
});

test("two-provider agreement detects same-shape trace commitments, gas, raw logs, and inclusion changes", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-stage1-commitments-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const made = makeSource(parent);
  for (const variant of [{ inputVariant: "provider-02" }, { outputVariant: "provider-02" }, { gasVariant: "provider-02" }, { logVariant: "provider-02" }, { inclusionVariant: "provider-02" }]) {
    await assert.rejects(() => morphoFundedArbitrageTraceVerifier({ ...verifierOptions(made), transport: transport(made, variant) }), /two-independent-canonical-trace-providers-unavailable/);
  }
  await assert.rejects(() => morphoFundedArbitrageTraceVerifier({ ...verifierOptions(made), type2Serializer: (transaction) => ({ bytes: "0x02aabb", hash: `0x${"f".repeat(64)}`, from: transaction.from }) }), /two-independent-canonical-trace-providers-unavailable/);
});

test("creation and destruction are normalized only with complete participants and remain economics blockers", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-stage1-lifecycle-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const made = makeSource(parent); const base = transport(made);
  const lifecycleTransport = async (request) => {
    const returned = await base(request);
    if (request.method === "debug_traceTransaction") returned.result.calls.push({ type: "CREATE2", from: EXECUTOR, to: "0x1111111111111111111111111111111111111111", value: "0x0", input: "0x01", output: "0x02", gas: "0x20", gasUsed: "0x10" });
    return returned;
  };
  const result = await morphoFundedArbitrageTraceVerifier({ ...verifierOptions(made), transport: lifecycleTransport });
  assert.equal(result.bundle["trace-projection.json"].trace.lifecycleSemantics.observed, true);
  assert.ok(result.bundle["stage1-verdict.json"].missingVectors.includes("creation-or-selfdestruct-economics-unproven"));
});

test("provider-family, trace-agreement, fixed-target, hard-cap, and source-immutability gates fail closed", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-stage1-gates-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const first = makeSource(path.join(parent, "one"));
  await assert.rejects(() => morphoFundedArbitrageTraceVerifier({ ...verifierOptions(first), hash: `0x${"9".repeat(64)}` }), /exact-target-hash-required/);
  await assert.rejects(() => morphoFundedArbitrageTraceVerifier({ ...verifierOptions(first), inventoryEntries: inventory(2, true) }), /two-independent-canonical-trace-providers-unavailable/);
  await assert.rejects(() => morphoFundedArbitrageTraceVerifier({ ...verifierOptions(first), transport: transport(first, { traceVariant: "provider-02" }) }), /two-independent-canonical-trace-providers-unavailable/);
  await assert.rejects(() => morphoFundedArbitrageTraceVerifier({ ...verifierOptions(first), transport: transport(first, { inclusionVariant: "provider-01" }) }), /two-independent-canonical-trace-providers-unavailable/);
  await assert.rejects(() => morphoFundedArbitrageTraceVerifier({ ...verifierOptions(first), limits: { requests: 241 } }), /invalid-limits/);

  const secondParent = path.join(parent, "two"); fs.mkdirSync(secondParent); const second = makeSource(secondParent);
  await assert.rejects(() => morphoFundedArbitrageTraceVerifier({ ...verifierOptions(second), transport: transport(second, { mutateSource: true }) }), /source-bytes-changed/);
});

test("every Stage 1 limit is finite, integral, bounded, known, and relationally valid", () => {
  assert.deepEqual(validateLimits({}), STAGE1_LIMITS);
  for (const field of Object.keys(STAGE1_LIMITS)) {
    for (const value of [NaN, Infinity, 1.5, -1]) assert.throws(() => validateLimits({ [field]: value }), /invalid-limits/, `${field}:${value}`);
  }
  for (const row of [{ unknown: 1 }, { traceNodeLimit: 2049 }, { traceDepthLimit: 65 }, { addressClosure: 65 }, { requestTimeoutMs: 8001 }, { totalTimeoutMs: 300001 }, { responseBytes: 16777217 }, { totalResponseBytes: 268435457 }, { outputBytes: 2097153 }, { providerCap: 4 }, { candidatePool: 1 }, { traceConcurrency: 2, concurrency: 1 }, { responseBytes: 100, totalResponseBytes: 99 }, { requestTimeoutMs: 10, totalTimeoutMs: 9 }, { traceProjectionLimit: 2, traceNodeLimit: 1 }]) assert.throws(() => validateLimits(row), /invalid-limits/);
});

test("atomic write cleanup leaves no partially visible Stage 1 directory", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-stage1-atomic-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const made = makeSource(parent);
  const result = await morphoFundedArbitrageTraceVerifier({ ...verifierOptions(made), transport: transport(made, { nativeBinding: true }) });
  assert.equal(result.bundle["arithmetic-fixture.json"].wethNativeBinding.complete, true);
  const output = path.join(parent, "failed-output");
  assert.throws(() => atomicBundle(output, result.bundle, { beforeRename() { throw new Error("injected-write-failure"); } }), /injected-write-failure/);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(parent).filter((name) => name.startsWith("failed-output")), []);
});

test("source mutation at the Stage 1 atomic pre-rename gate cannot expose an artifact", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "morpho-stage1-race-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const made = makeSource(parent); const result = await morphoFundedArbitrageTraceVerifier(verifierOptions(made)); const output = path.join(parent, "raced-output");
  const options = atomicWriteOptions("morpho-stage1", result); const guard = options.beforeRename;
  options.beforeRename = () => { fs.appendFileSync(path.join(made.directory, "candidates.json"), " "); guard(); };
  assert.throws(() => atomicBundle(output, result.bundle, options), /source-bytes-changed/);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(parent).filter((name) => name.startsWith("raced-output")), []);
});
