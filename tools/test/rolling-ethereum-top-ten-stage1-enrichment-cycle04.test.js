"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const gate = require("../atomic/ethereum-top-trades-7d-reconstruction/rolling-ethereum-top-ten-stage1-enrichment-cycle04");

const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222", C = "0x3333333333333333333333333333333333333333";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PROBE = `0x${"99".repeat(32)}`, CANDIDATE_BLOCK_HASH = `0x${"88".repeat(32)}`;
function h(index) { return `0x${BigInt(index).toString(16).padStart(64, "0")}`; }
function topicAddress(address) { return `0x${address.slice(2).padStart(64, "0")}`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function q(value) { return `0x${BigInt(value).toString(16)}`; }
function copyStage0() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-stage1-stage0-")); for (const name of ["manifest.json", "state.json"]) fs.copyFileSync(path.join(gate.STAGE0_DIRECTORY, name), path.join(directory, name)); return directory; }

function transferLog(transactionHash, transactionIndex, logIndex, from, to, amount) {
  return { address: C, topics: [TRANSFER, topicAddress(from), topicAddress(to)], data: h(amount), blockHash: CANDIDATE_BLOCK_HASH, blockNumber: q(BigInt(gate.STAGE0_CURSOR.startBlockNumber) + 5n), transactionHash, transactionIndex: q(transactionIndex), logIndex: q(logIndex), removed: false };
}
function rawTransaction(transactionHash, transactionIndex, blockHash = CANDIDATE_BLOCK_HASH, blockNumber = BigInt(gate.STAGE0_CURSOR.startBlockNumber) + 5n) {
  return { hash: transactionHash, blockHash, blockNumber: q(blockNumber), transactionIndex: q(transactionIndex), from: A, to: B, value: "0x0", type: "0x2", nonce: q(transactionIndex), gas: "0x5208", gasPrice: null, maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", maxFeePerBlobGas: null, chainId: "0x1", input: "0x" };
}
function rawReceipt(transactionHash, transactionIndex, logs = [], blockHash = CANDIDATE_BLOCK_HASH, blockNumber = BigInt(gate.STAGE0_CURSOR.startBlockNumber) + 5n) {
  return { transactionHash, blockHash, blockNumber: q(blockNumber), transactionIndex: q(transactionIndex), status: "0x1", gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x2", blobGasUsed: null, blobGasPrice: null, contractAddress: null, logs };
}
function rawBlock(full = true) {
  const number = BigInt(gate.STAGE0_CURSOR.startBlockNumber) + 5n;
  return { hash: CANDIDATE_BLOCK_HASH, parentHash: h(7001), number: q(number), timestamp: "0x64", miner: C, stateRoot: h(7002), receiptsRoot: h(7003), transactionsRoot: h(7004), gasUsed: "0x100000", gasLimit: "0x200000", baseFeePerGas: "0x1", blobGasUsed: null, excessBlobGas: null, transactions: gate.STAGE0_HASHES.map((hash, index) => full ? rawTransaction(hash, index) : hash) };
}
function rawView(transactionHash = gate.STAGE0_HASHES[0], index = gate.STAGE0_HASHES.indexOf(transactionHash), withTransfers = true) {
  const logs = withTransfers ? [transferLog(transactionHash, index, 0, A, B, 5), transferLog(transactionHash, index, 1, B, A, 5)] : [];
  return { transaction: rawTransaction(transactionHash, index), receipt: rawReceipt(transactionHash, index, logs), block: rawBlock(true) };
}
function normalizedView(transactionHash = gate.STAGE0_HASHES[0], index = gate.STAGE0_HASHES.indexOf(transactionHash), withTransfers = true) { return gate.validateExactView(rawView(transactionHash, index, withTransfers), transactionHash, gate.STAGE0_CURSOR); }
function trace(value = "0x0", calls = []) { return { from: A, to: B, value, type: "CALL", calls }; }
function availableTrace(view) { return gate.reconcileTrace({ status: "fulfilled", value: trace() }, { status: "fulfilled", value: trace() }, view); }
function proof(category) { return Object.fromEntries([["category", category], ...gate.MISMATCH_CATEGORIES.includes(category) ? [] : [] , ...({
  ACCOUNTING_CONSERVATION: ["complete", "reproducible", "dualAgreement", "debitsKnown", "creditsKnown", "obligationsKnown", "imbalanceNonzero"],
  AUTHORIZATION_OR_RECIPIENT: ["complete", "reproducible", "dualAgreement", "authorizedRecipientKnown", "observedRecipientKnown", "recipientMismatch"],
  REPLAY_OR_DUPLICATE: ["complete", "reproducible", "dualAgreement", "identityDomainKnown", "duplicateIdentityObserved", "distinctOccurrenceProof"],
  PRICE_OR_PRECISION: ["complete", "reproducible", "dualAgreement", "inputsKnown", "roundingRuleKnown", "exactBoundViolated"],
  PUBLIC_STATE_TRANSITION: ["complete", "reproducible", "dualAgreement", "preconditionKnown", "transitionKnown", "unauthorizedPublicTransition"],
}[category] || []).map((key) => [key, true])]); }
function runtime(requestsUsed = 0, traceRequestsUsed = 0) { return { mode: "INJECTED_READ_ONLY", independentFamilyCount: 2, requestsUsed, requestCap: gate.STAGE1_LIMITS.requests, traceRequestsUsed, traceRequestCap: 20, concurrencyCap: 2, historicalFinalizedOnly: true, webReads: false, inventoryReads: false, publication: false }; }
function offlineBundle(anchor = gate.snapshotStage0()) { const rows = gate.STAGE0_HASHES.map((hash, index) => { const view = normalizedView(hash, index, false); return gate.buildRow(hash, view, availableTrace(view), null, null, anchor.reviewContexts[index]); }); return gate.buildBundle(anchor, rows, runtime()); }

test("exact Stage0 bytes, cursor, rank, and immutable top-ten set are bound and tamper fails", () => {
  const directory = copyStage0();
  try {
    const anchor = gate.snapshotStage0(directory); assert.deepEqual(anchor.manifest, gate.STAGE0_MANIFEST); assert.deepEqual(anchor.state, gate.STAGE0_STATE); assert.deepEqual(anchor.cursor, gate.STAGE0_CURSOR); assert.deepEqual(anchor.transactionHashes, gate.STAGE0_HASHES);
    fs.appendFileSync(path.join(directory, "state.json"), " "); assert.throws(() => gate.snapshotStage0(directory), /ROLLING_STAGE1_STAGE0_TAMPER/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("cycle04 fixed source/output pins and all cycle01-04 and prior Stage1 artifacts validate immutably", () => {
  assert.equal(path.basename(gate.STAGE0_DIRECTORY), "rolling-ethereum-top-ten-20260828-04"); assert.equal(gate.LIVE_OUTPUT_BASENAME, "rolling-ethereum-top-ten-stage1-20260828-04"); assert.equal(gate.STAGE0_MANIFEST.sha256, "14aee63be8ed3e03948e2fd6df50db5301a938e57376440a145a9b337507842e"); assert.equal(gate.STAGE0_STATE.sha256, "4b9ef64b974efc140ea26cf726c5bf1129cfdb806371fd92106eedb0df0dcb98"); assert.equal(gate.STAGE0_HASHES.length, 10); assert.equal(Object.keys(gate.snapshotPreserved()).length, gate.PRESERVATION_FILES.length);
});

test("cycle01-03 report artifacts remain byte-identical across cycle04 historical validation", () => {
  const historicalNames = ["cycle01Manifest", "cycle01State", "cycle02Manifest", "cycle02State", "cycle03Manifest", "cycle03State", "cycle01Stage1Manifest", "cycle01Stage1Bundle", "cycle02Stage1Manifest", "cycle02Stage1Bundle"], before = gate.snapshotPreserved();
  gate.snapshotStage0(); const after = gate.snapshotPreserved();
  assert.deepEqual(Object.fromEntries(historicalNames.map((name) => [name, after[name]])), Object.fromEntries(historicalNames.map((name) => [name, before[name]]))); assert.equal(historicalNames.every((name) => before[name] && /^[0-9a-f]{64}$/.test(before[name].sha256)), true);
});

test("dual transaction, receipt, exact block, and full-block identity agreement is mandatory", () => {
  const first = rawView(), second = clone(first), agreed = gate.dualAgreement(first, second, gate.STAGE0_HASHES[0], gate.STAGE0_CURSOR); assert.equal(agreed.transaction.hash, gate.STAGE0_HASHES[0]); assert.equal(agreed.fullBlockTransactionCount, 10);
  const receiptMismatch = clone(second); receiptMismatch.receipt.gasUsed = "0x5209"; assert.throws(() => gate.dualAgreement(first, receiptMismatch, gate.STAGE0_HASHES[0], gate.STAGE0_CURSOR), /ROLLING_STAGE1_DUAL_DISAGREEMENT/);
  const blockMismatch = clone(second); blockMismatch.block.transactions[1].hash = h(12345); assert.throws(() => gate.dualAgreement(first, blockMismatch, gate.STAGE0_HASHES[0], gate.STAGE0_CURSOR), /ROLLING_STAGE1_DUAL_DISAGREEMENT/);
  const hashesOnly = clone(first); hashesOnly.block.transactions = hashesOnly.block.transactions.map((row) => row.hash); assert.throws(() => gate.validateExactView(hashesOnly, gate.STAGE0_HASHES[0], gate.STAGE0_CURSOR), /ROLLING_STAGE1_FULL_BLOCK_REQUIRED/);
});

test("trace unavailable, malformed, and disagreement remain UNKNOWN rather than negative", () => {
  const view = normalizedView();
  const unavailable = gate.reconcileTrace({ status: "rejected" }, { status: "fulfilled", value: trace() }, view); assert.deepEqual(unavailable, { status: "UNKNOWN", reason: "UNAVAILABLE", nativeMovements: [], complete: false });
  const malformed = gate.reconcileTrace({ status: "fulfilled", value: { ...trace(), calls: "bad" } }, { status: "fulfilled", value: trace() }, view); assert.equal(malformed.status, "UNKNOWN"); assert.equal(malformed.reason, "MALFORMED");
  const child = { type: "CALL", from: A, to: C, value: "0x1" }, disagree = gate.reconcileTrace({ status: "fulfilled", value: trace("0x0", [child]) }, { status: "fulfilled", value: trace() }, view); assert.equal(disagree.status, "UNKNOWN"); assert.equal(disagree.reason, "DISAGREEMENT");
});

test("safe ERC20/native ledger permits balanced rejection only when evidence is complete", () => {
  const view = normalizedView(), complete = availableTrace(view), obligations = [], context = gate.snapshotStage0().reviewContexts[0], ledger = gate.buildLedger(view, complete, obligations); assert.equal(ledger.tokenFlows.length, 2); assert.equal(ledger.knownFees.totalFeeWei, "42000"); assert.equal(ledger.knownObligations.status, "COMPLETE"); assert.equal(ledger.conservation.complete, true); assert.equal(ledger.conservation.balanced, true);
  const balanced = gate.buildRow(gate.STAGE0_HASHES[0], view, complete, null, obligations, context); assert.deepEqual(balanced.classification, { disposition: "REJECTED", basis: "COMPLETE_BALANCED_FLOW", category: null });
  const incomplete = gate.buildRow(gate.STAGE0_HASHES[0], view, { status: "UNKNOWN", reason: "UNAVAILABLE", nativeMovements: [], complete: false }, null, null, context); assert.deepEqual(incomplete.classification, { disposition: "UNKNOWN", basis: "INCOMPLETE_EVIDENCE", category: null }); assert.equal(incomplete.ledger.conservation.balanced, "unknown");
});

test("scorer-v2 strong precursors are review context only and each WATCH requires independent concrete reproducible proof", () => {
  const anchor = gate.snapshotStage0(), view = normalizedView(), complete = availableTrace(view), context = anchor.reviewContexts[0];
  assert.equal(anchor.reviewContexts.length, 10); assert.equal(anchor.reviewContexts.every((row) => row.status === "REVIEW_CONTEXT_ONLY" && row.mismatchProof === false && row.strongPrecursorClasses.length >= 1), true); assert.equal(anchor.prefilterProjectionCommitment, gate.PREFILTER_PROJECTION_COMMITMENT); assert.equal(anchor.scorerProjectionCommitment, gate.SCORER_PROJECTION_COMMITMENT);
  const precursorOnly = gate.buildRow(gate.STAGE0_HASHES[0], view, complete, null, null, context); assert.notEqual(precursorOnly.classification.disposition, "WATCH"); assert.equal(precursorOnly.mismatch, null);
  for (const category of gate.MISMATCH_CATEGORIES) { const row = gate.buildRow(gate.STAGE0_HASHES[0], view, complete, proof(category), null, context); assert.equal(row.classification.disposition, "WATCH"); assert.equal(row.classification.category, category); assert.equal(row.mismatch.proofComplete, true); }
  const falseProof = proof("ACCOUNTING_CONSERVATION"); falseProof.imbalanceNonzero = false; assert.throws(() => gate.buildRow(gate.STAGE0_HASHES[0], view, complete, falseProof, null, context), /ROLLING_STAGE1_MISMATCH_PROOF/);
});

test("bundle validator enforces the exact ten and rejects false mismatch/nonclaim/cap/leak mutations", () => {
  const bundle = offlineBundle(); assert.equal(gate.validateBundle(bundle), true); assert.deepEqual(bundle.rows.map((row) => row.transactionHash), gate.STAGE0_HASHES);
  for (const mutate of [
    (value) => { value.rows.pop(); },
    (value) => { value.rows[0].transactionHash = h(42); },
    (value) => { value.rows[0].classification = { disposition: "WATCH", basis: "CONCRETE_REPRODUCIBLE_MISMATCH", category: "ACCOUNTING_CONSERVATION" }; },
    (value) => { const evidence = proof("ACCOUNTING_CONSERVATION"); value.rows[0].mismatch = { category: "ACCOUNTING_CONSERVATION", status: "CONCRETE_REPRODUCIBLE", evidence, proofCommitment: "0".repeat(64), proofComplete: true, reproducible: true, dualAgreement: true }; value.rows[0].classification = { disposition: "WATCH", basis: "CONCRETE_REPRODUCIBLE_MISMATCH", category: "ACCOUNTING_CONSERVATION" }; value.summary.rejectedBalanced -= 1; value.summary.watch += 1; value.summary.mismatchCategories.ACCOUNTING_CONSERVATION += 1; },
    (value) => { value.rows[0].nonclaims.routePositive = true; },
    (value) => { value.runtime.requestsUsed = gate.STAGE1_LIMITS.requests + 1; },
    (value) => { value.runtime.traceRequestsUsed = 21; },
    (value) => { value.endpoint = "secret"; },
    (value) => { value.rows[0].ledger.tokenFlows[0] = { url: "https://secret.invalid" }; },
  ]) { const changed = clone(bundle); mutate(changed); assert.throws(() => gate.validateBundle(changed)); }
});

test("future writer is atomic, no-overwrite, race-safe, and catches manifest tamper", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-stage1-write-")), bundle = offlineBundle();
  try {
    const target = path.join(parent, "rolling-ethereum-top-ten-stage1-test"); assert.equal(gate.writeBundle(target, bundle, { approvedParent: parent }).postvalidated, true); assert.equal(gate.validateDirectory(target).rows.length, 10); assert.throws(() => gate.writeBundle(target, bundle, { approvedParent: parent }), /ROLLING_STAGE1_OUTPUT_EXISTS/);
    fs.writeFileSync(path.join(target, "manifest.json"), "{}\n"); assert.throws(() => gate.validateDirectory(target), /ROLLING_STAGE1_MANIFEST/);
    const raced = path.join(parent, "rolling-ethereum-top-ten-stage1-race"); assert.throws(() => gate.writeBundle(raced, bundle, { approvedParent: parent, beforeRename: (_staging, final) => { fs.mkdirSync(final); fs.writeFileSync(path.join(final, "sentinel"), "foreign"); } }), /ROLLING_STAGE1_OUTPUT_EXISTS/); assert.equal(fs.readFileSync(path.join(raced, "sentinel"), "utf8"), "foreign");
    const failed = path.join(parent, "rolling-ethereum-top-ten-stage1-postvalidation-failure"); assert.throws(() => gate.writeBundle(failed, bundle, { approvedParent: parent, postValidate: () => { throw new Error("fixture-postvalidation-failure"); } }), /fixture-postvalidation-failure/); assert.equal(fs.existsSync(failed), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("preflight performs no reads or writes and real CLI exposes no capture mode", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-stage1-preflight-"));
  try { const before = fs.readdirSync(directory), output = []; const result = gate.runCli(["--preflight-only"], { stdout: (value) => output.push(value), stderr: () => assert.fail("unexpected stderr"), setExitCode: () => assert.fail("unexpected exit") }); assert.deepEqual(result, gate.preflight()); assert.deepEqual(fs.readdirSync(directory), before); assert.equal(JSON.parse(output[0]).rpcReads, false); let code; assert.deepEqual(gate.runCli(["--capture"], { stdout: () => {}, stderr: () => {}, setExitCode: (value) => { code = value; } }), { ok: false, code: "ROLLING_STAGE1_PRODUCTION_DISABLED" }); assert.equal(code, 1); code = null; assert.deepEqual(gate.runCli(["--live-capture"], { stdout: () => {}, stderr: () => {}, setExitCode: (value) => { code = value; } }), { ok: false, code: "ROLLING_STAGE1_PRODUCTION_DISABLED" }); assert.equal(code, 1); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function finalHeader(full = false) { return { hash: gate.STAGE0_CURSOR.finalizedBlockHash, parentHash: h(6001), number: q(gate.STAGE0_CURSOR.finalizedBlockNumber), timestamp: "0x1000", miner: C, stateRoot: h(6002), receiptsRoot: h(6003), transactionsRoot: h(6004), gasUsed: "0x100", gasLimit: "0x200", baseFeePerGas: "0x1", blobGasUsed: null, excessBlobGas: null, transactions: full ? [rawTransaction(PROBE, 0, gate.STAGE0_CURSOR.finalizedBlockHash, BigInt(gate.STAGE0_CURSOR.finalizedBlockNumber))] : [PROBE] }; }
function probeReceipt() { return rawReceipt(PROBE, 0, [], gate.STAGE0_CURSOR.finalizedBlockHash, BigInt(gate.STAGE0_CURSOR.finalizedBlockNumber)); }
function injectedFixture() {
  const traces = [], calls = [];
  const transport = async ({ provider, method, params }) => {
    calls.push({ ordinal: provider.ordinal, method }); let result;
    if (method === "eth_chainId") result = "0x1";
    else if (method === "eth_getLogs") result = [];
    else if (method === "eth_getBlockByNumber") { if (params[0] === "finalized" || BigInt(params[0]) === BigInt(gate.STAGE0_CURSOR.finalizedBlockNumber)) result = finalHeader(false); else { const number = BigInt(params[0]); result = { ...finalHeader(false), number: q(number), hash: h(number) }; } }
    else if (method === "eth_getTransactionByHash") result = params[0] === PROBE ? rawTransaction(PROBE, 0, gate.STAGE0_CURSOR.finalizedBlockHash, BigInt(gate.STAGE0_CURSOR.finalizedBlockNumber)) : rawView(params[0], gate.STAGE0_HASHES.indexOf(params[0]), false).transaction;
    else if (method === "eth_getTransactionReceipt") result = params[0] === PROBE ? probeReceipt() : rawView(params[0], gate.STAGE0_HASHES.indexOf(params[0]), false).receipt;
    else if (method === "eth_getBlockByHash") result = params[0] === gate.STAGE0_CURSOR.finalizedBlockHash ? finalHeader(params[1] === true) : rawBlock(params[1] === true);
    else if (method === "debug_traceTransaction") { traces.push(params[0]); result = trace(); }
    else throw new Error("unexpected-method");
    return { result };
  };
  const inventoryEntries = [{ url: "https://first.secret.invalid", lineIndex: 0, ethereumHint: true, unsupportedMode: false, groupIdentity: Symbol("first"), declaredGroup: true }, { url: "https://second.secret.invalid", lineIndex: 1, ethereumHint: true, unsupportedMode: false, groupIdentity: Symbol("second"), declaredGroup: true }];
  return { transport, inventoryEntries, traces, calls };
}

test("injected capture alone uses two qualified families, exact hashes, and bounded requests/traces without leaks or publication", async () => {
  const directory = copyStage0(), fixture = injectedFixture();
  try {
    await assert.rejects(() => gate.captureInjected(), /ROLLING_STAGE1_PRODUCTION_DISABLED/);
    const bundle = await gate.captureInjected({ stage0Directory: directory, inventoryEntries: fixture.inventoryEntries, transport: fixture.transport }); assert.equal(gate.validateBundle(bundle), true); assert.equal(bundle.runtime.independentFamilyCount, 2); assert.ok(bundle.runtime.requestsUsed <= gate.STAGE1_LIMITS.requests); assert.equal(bundle.runtime.traceRequestsUsed, 20); assert.equal(new Set(fixture.traces).size, 10); assert.deepEqual([...new Set(fixture.traces)].sort(), [...gate.STAGE0_HASHES].sort()); assert.equal(bundle.nonclaims.publication, false);
    const serialized = JSON.stringify(bundle); assert.equal(serialized.includes("secret.invalid"), false); assert.equal(/(?:https?|wss?):\/\//i.test(serialized), false); assert.equal(serialized.includes("calldata"), false); assert.equal(serialized.includes("rawTrace"), false);
    await assert.rejects(() => gate.captureInjected({ stage0Directory: directory, inventoryEntries: fixture.inventoryEntries, transport: fixture.transport, mismatchProofs: { [h(123)]: proof("ACCOUNTING_CONSERVATION") } }), /ROLLING_STAGE1_ARBITRARY_HASH/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("injected live-capture adapter reads inventory once and atomically postvalidates sanitized output", async () => {
  const stage0Directory = copyStage0(), approvedParent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-stage1-live-")), outputDirectory = path.join(approvedParent, "rolling-ethereum-top-ten-stage1-test-live"), fixture = injectedFixture(), preservedBefore = gate.snapshotPreserved(); let inventoryReads = 0;
  try {
    const stdout = [], stderr = [], summary = await gate.runCli(["--live-capture"], { dependencies: { productionAdapter: () => gate.liveCaptureAdapter({ stage0Directory, approvedParent, outputDirectory, readInventory: () => { inventoryReads += 1; return fixture.inventoryEntries; }, transport: fixture.transport }) }, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), setExitCode: () => assert.fail("unexpected exit") });
    assert.equal(inventoryReads, 1); assert.equal(summary.ok, true); assert.equal(summary.cycles, 1); assert.equal(summary.postvalidated, true); assert.equal(summary.signing, false); assert.equal(summary.broadcast, false); assert.equal(summary.fork, false);
    const bundle = gate.validateDirectory(outputDirectory); assert.equal(bundle.runtime.mode, "LIVE_CAPTURE_ONCE"); assert.equal(bundle.runtime.inventoryReads, true); assert.equal(bundle.nonclaims.signing, false); assert.equal(bundle.nonclaims.broadcast, false); assert.equal(bundle.nonclaims.forkClaim, false); gate.assertPreserved(preservedBefore, gate.snapshotPreserved());
    const serialized = `${fs.readFileSync(path.join(outputDirectory, "bundle.json"), "utf8")}${fs.readFileSync(path.join(outputDirectory, "manifest.json"), "utf8")}${stdout.join("")}${stderr.join("")}`; assert.equal(serialized.includes("secret.invalid"), false); assert.equal(/(?:https?|wss?):\/\//i.test(serialized), false); assert.equal(serialized.includes("rawTrace"), false); assert.equal(serialized.includes("calldata"), false);
  } finally { fs.rmSync(stage0Directory, { recursive: true, force: true }); fs.rmSync(approvedParent, { recursive: true, force: true }); }
});

test("live-capture rejects a preexisting target before inventory read", async () => {
  const stage0Directory = copyStage0(), approvedParent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-stage1-existing-")), outputDirectory = path.join(approvedParent, "rolling-ethereum-top-ten-stage1-test-existing"), preservedBefore = gate.snapshotPreserved(); let inventoryReads = 0;
  try { fs.mkdirSync(outputDirectory); fs.writeFileSync(path.join(outputDirectory, "sentinel"), "foreign"); await assert.rejects(() => gate.liveCaptureAdapter({ stage0Directory, approvedParent, outputDirectory, readInventory: () => { inventoryReads += 1; return []; } }), /ROLLING_STAGE1_OUTPUT_EXISTS/); assert.equal(inventoryReads, 0); assert.equal(fs.readFileSync(path.join(outputDirectory, "sentinel"), "utf8"), "foreign"); gate.assertPreserved(preservedBefore, gate.snapshotPreserved()); }
  finally { fs.rmSync(stage0Directory, { recursive: true, force: true }); fs.rmSync(approvedParent, { recursive: true, force: true }); }
});

test("live-capture failure creates no output and emits only safe lifecycle nonclaims", async () => {
  const stage0Directory = copyStage0(), approvedParent = fs.mkdtempSync(path.join(os.tmpdir(), "rolling-stage1-failure-")), outputDirectory = path.join(approvedParent, "rolling-ethereum-top-ten-stage1-test-failure"), errors = [], preservedBefore = gate.snapshotPreserved(); let exitCode;
  try {
    const result = await gate.runCli(["--live-capture"], { dependencies: { productionAdapter: () => gate.liveCaptureAdapter({ stage0Directory, approvedParent, outputDirectory, readInventory: () => [], transport: async () => {}, capture: async () => { throw new Error("fixture-capture-failure"); } }) }, stdout: () => assert.fail("unexpected success"), stderr: (value) => errors.push(JSON.parse(value)), setExitCode: (value) => { exitCode = value; } });
    assert.deepEqual(result, { ok: false, code: "ROLLING_STAGE1_CAPTURE_FAILED", signing: false, broadcast: false, fork: false }); assert.deepEqual(errors, [result]); assert.equal(exitCode, 1); assert.equal(fs.existsSync(outputDirectory), false); assert.deepEqual(fs.readdirSync(approvedParent), []); gate.assertPreserved(preservedBefore, gate.snapshotPreserved());
  } finally { fs.rmSync(stage0Directory, { recursive: true, force: true }); fs.rmSync(approvedParent, { recursive: true, force: true }); }
});
