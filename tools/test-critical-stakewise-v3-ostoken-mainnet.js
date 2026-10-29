#!/usr/bin/env node
"use strict";

const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Interface } = require("ethers");
const runner = require("./critical-stakewise-v3-ostoken-mainnet-runner.js");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_PATH = path.join(__dirname, "fixtures", "critical-stakewise-v3-ostoken-mainnet-fixtures.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;
const ADDRESS_A = `0x${"11".repeat(20)}`;
let checks = 0;

function equal(actual, expected, message) {
  checks += 1;
  assert.deepStrictEqual(actual, expected, `check ${checks}: ${message}`);
}

function check(value, message) {
  checks += 1;
  assert.ok(value, `check ${checks}: ${message}`);
}

function throwsCode(fn, code, message) {
  checks += 1;
  assert.throws(fn, new RegExp(code, "u"), `check ${checks}: ${message}`);
}

async function rejectsCode(fn, code, message) {
  checks += 1;
  await assert.rejects(fn, new RegExp(code, "u"), `check ${checks}: ${message}`);
}

function streamResponse(chunks, status = 200) {
  let index = 0;
  let cancelled = false;
  return {
    status,
    redirected: false,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => index < chunks.length
          ? { done: false, value: Buffer.from(chunks[index++], "utf8") }
          : { done: true, value: undefined },
        cancel: async () => { cancelled = true; }
      })
    },
    wasCancelled: () => cancelled
  };
}

function rpcEnvelope(idValue, result) {
  return JSON.stringify({ jsonrpc: "2.0", id: idValue, result });
}

function approvalAt(now) {
  const expected = {
    approvalId: "swv3-ostoken-0123456789abcdef0123456789abcdef",
    runnerSha256: `0x${"11".repeat(32)}`,
    packageManifestSha256: `0x${"22".repeat(32)}`,
    packageAggregateSha256: `0x${"33".repeat(32)}`,
    packageSourceBinding: `0x${"44".repeat(32)}`,
    proposalCommitment: `0x${"55".repeat(32)}`,
    reviewMaterialManifestSha256: `0x${"66".repeat(32)}`
  };
  const approvalPayload = {
    approvalId: expected.approvalId,
    findingId: runner.FINDING_ID,
    chainId: 1,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    authorizedCaptureCount: 1,
    fixedApprovalPath: runner.FIXED_APPROVAL_REL,
    fixedOutputPath: runner.FIXED_OUTPUT_REL,
    globalConsumptionLedger: runner.GLOBAL_LEDGER_REL,
    endpointInventoryReadAuthorized: true,
    transactionsAuthorized: false,
    traceAuthorized: false,
    forkAuthorized: false,
    runnerSha256: expected.runnerSha256,
    packageManifestSha256: expected.packageManifestSha256,
    packageAggregateSha256: expected.packageAggregateSha256,
    packageSourceBinding: expected.packageSourceBinding,
    proposalCommitment: expected.proposalCommitment,
    reviewMaterialManifestSha256: expected.reviewMaterialManifestSha256,
    capsCommitment: runner.bytes32Commitment(runner.CAPS),
    allowedMethods: [...runner.ALLOWED_METHODS].sort(),
    approvalAuthenticityAssumption: "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM"
  };
  return {
    expected,
    approval: {
      schemaVersion: 2,
      state: "AUTHORIZED",
      approvalPayload,
      approvalCommitment: runner.bytes32Commitment(approvalPayload)
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function observations() {
  return fixture.pinObservations.map((row) => ({
    ...row,
    header: { ...row.header, number: BigInt(row.header.number), timestamp: BigInt(row.header.timestamp) }
  }));
}

async function main() {
  equal(fixture.fixtureClasses.length, 48, "all required deterministic fixture classes present");
  const requiredClasses = ["approval-replay", "approval-expiry", "approval-path-binding", "approval-runner-hash-binding",
    "budget-total-exhaustion", "hostname-family-threshold", "finalized-hash-mismatch", "forbidden-storage-method",
    "forbidden-trace-method", "forbidden-send-method", "url-leak-guard", "provider-hash-leak-guard",
    "transaction-hash-leak-guard", "arbitrary-address-leak-guard", "check-only-zero-side-effects"];
  for (const fixtureClass of requiredClasses) check(fixture.fixtureClasses.includes(fixtureClass), `fixture ${fixtureClass}`);

  const preflight = runner.dryPreflight();
  equal(preflight.status, "PREPARED_REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED", "preflight status");
  equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "preflight side effects zero");
  equal([preflight.authorization.proposalState, preflight.authorization.proposalAuthorization,
    preflight.authorization.authorized, preflight.authorization.captureExecuted],
  ["REVIEW_REQUESTED", "NOT_AUTHORIZED", false, false], "proposal is not approval");
  equal(preflight.methods.allowed, ["eth_call", "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs"],
    "method allowlist exact");
  check(preflight.methods.forbidden.includes("eth_getStorageAt") && preflight.methods.forbidden.includes("debug_traceCall") &&
    preflight.methods.forbidden.includes("eth_sendRawTransaction"), "storage trace send methods explicitly forbidden");
  equal(Object.values(preflight.gates).slice(0, 6), [null, null, null, null, null, null], "exposure gates start null");
  check(preflight.localBindings.sourceClosureFileCount >= 60, "recursive osToken source closure bound");
  equal(preflight.localBindings.deploymentRoleLabels, ["config", "controller", "escrow", "redeemer", "registry", "token"],
    "mainnet deployment role seeds bound without addresses");

  equal(runner.parseArgs(["node", "runner", "--check-only"]), { capture: false, checkOnly: true, approvalFile: null },
    "explicit check-only");
  throwsCode(() => runner.parseArgs(["node", "runner", "--check-only", "--capture-once"]), "MODE_CONFLICT", "modes exclusive");
  throwsCode(() => runner.parseArgs(["node", "runner", "--capture-once", "--output", "elsewhere"]), "UNKNOWN_ARGUMENT",
    "fixed output cannot be overridden");

  const watched = [runner.FIXED_OUTPUT_REL, runner.GLOBAL_LEDGER_REL, runner.FIXED_APPROVAL_REL]
    .map((value) => path.join(ROOT, ...value.split("/")));
  const before = watched.map((value) => fs.existsSync(value));
  const child = cp.spawnSync(process.execPath, [path.join(__dirname, "critical-stakewise-v3-ostoken-mainnet-runner.js"), "--check-only"],
    { cwd: ROOT, encoding: "utf8", env: {} });
  equal(child.status, 0, "check-only exits zero");
  equal(child.stderr, "", "check-only stderr empty");
  equal(JSON.parse(child.stdout), preflight, "check-only deterministic output");
  equal(watched.map((value) => fs.existsSync(value)), before, "check-only creates no approval ledger or capture");

  const now = Date.parse("2026-08-01T12:00:00.000Z");
  const valid = approvalAt(now);
  equal(runner.validateApprovalEnvelope(valid.approval, { now, expected: valid.expected, consumed: false }).approvalId,
    valid.expected.approvalId, "fresh single-use approval validates");
  throwsCode(() => runner.validateApprovalEnvelope(valid.approval, { now, expected: valid.expected, consumed: true }),
    "APPROVAL_ALREADY_CONSUMED", "approval replay rejected");
  const expired = clone(valid.approval);
  expired.approvalPayload.issuedAt = new Date(now - 120000).toISOString();
  expired.approvalPayload.expiresAt = new Date(now - 1).toISOString();
  expired.approvalCommitment = runner.bytes32Commitment(expired.approvalPayload);
  throwsCode(() => runner.validateApprovalEnvelope(expired, { now, expected: valid.expected, consumed: false }),
    "APPROVAL_WINDOW_INVALID", "expired approval rejected");
  const changedPath = clone(valid.approval);
  changedPath.approvalPayload.fixedOutputPath = `${runner.FIXED_OUTPUT_REL}.other`;
  changedPath.approvalCommitment = runner.bytes32Commitment(changedPath.approvalPayload);
  throwsCode(() => runner.validateApprovalEnvelope(changedPath, { now, expected: valid.expected, consumed: false }),
    "APPROVAL_BINDING_INVALID", "fixed output path bound");
  const changedRunnerHash = clone(valid.approval);
  changedRunnerHash.approvalPayload.runnerSha256 = HASH_A;
  changedRunnerHash.approvalCommitment = runner.bytes32Commitment(changedRunnerHash.approvalPayload);
  throwsCode(() => runner.validateApprovalEnvelope(changedRunnerHash, { now, expected: valid.expected, consumed: false }),
    "APPROVAL_BINDING_INVALID", "runner hash bound");
  const changedManifestHash = clone(valid.approval);
  changedManifestHash.approvalPayload.packageManifestSha256 = HASH_B;
  changedManifestHash.approvalCommitment = runner.bytes32Commitment(changedManifestHash.approvalPayload);
  throwsCode(() => runner.validateApprovalEnvelope(changedManifestHash, { now, expected: valid.expected, consumed: false }),
    "APPROVAL_BINDING_INVALID", "manifest hash bound");
  const changedCommitment = clone(valid.approval);
  changedCommitment.approvalCommitment = HASH_A;
  throwsCode(() => runner.validateApprovalEnvelope(changedCommitment, { now, expected: valid.expected, consumed: false }),
    "APPROVAL_COMMITMENT_INVALID", "payload commitment exact");

  const totalBudget = new runner.Budget({ ...runner.CAPS, maxTotalRequests: 0 });
  throwsCode(() => totalBudget.consume("eth_chainId"), "BUDGET_EXHAUSTED_TOTAL_REQUESTS", "total request budget");
  const responseBudget = new runner.Budget({ ...runner.CAPS, maxAggregateResponseBytes: 1 });
  throwsCode(() => responseBudget.consumeResponse(2), "BUDGET_EXHAUSTED_AGGREGATE_RESPONSE_BYTES", "response byte budget");
  const logBudget = new runner.Budget({ ...runner.CAPS, maxLogs: 0 });
  throwsCode(() => logBudget.consumeLog(), "BUDGET_EXHAUSTED_LOG_ROWS", "log row budget");
  const chunkBudget = new runner.Budget({ ...runner.CAPS, maxChunks: 0 });
  throwsCode(() => chunkBudget.consumeChunk(), "BUDGET_EXHAUSTED_CHUNKS", "chunk budget");
  let clock = 0;
  const timeBudget = new runner.Budget({ ...runner.CAPS, maxElapsedMs: 1 }, () => { clock += 2; return clock; });
  throwsCode(() => timeBudget.consume("eth_chainId"), "BUDGET_EXHAUSTED_TIME", "elapsed time budget");
  for (const method of ["eth_getStorageAt", "debug_traceCall", "trace_transaction", "eth_sendRawTransaction", "eth_sendTransaction"]) {
    throwsCode(() => new runner.Budget().consume(method), "METHOD_FORBIDDEN", `${method} forbidden`);
  }

  const streamedContext = { caps: { ...runner.CAPS, retriesPerRequest: 0 }, budget: new runner.Budget(), nextId: 0 };
  const streamedBody = rpcEnvelope(1, "0x1");
  const streamed = await runner.rpcRequest({ url: "mock://family", family: "F1" }, "eth_chainId", [], streamedContext,
    async () => streamResponse([streamedBody.slice(0, 8), streamedBody.slice(8)]));
  equal([streamed.ok, streamed.result], [true, "0x1"], "streamed JSON-RPC body parsed");
  equal(streamedContext.budget.responseBytes, Buffer.byteLength(streamedBody), "stream chunks charged incrementally");

  let attempts = 0;
  const retryContext = { caps: { ...runner.CAPS, retriesPerRequest: 1 }, budget: new runner.Budget(), nextId: 0 };
  const retried = await runner.rpcRequest({ url: "mock://family", family: "F1" }, "eth_chainId", [], retryContext, async () => {
    attempts += 1;
    return attempts === 1 ? streamResponse([], 500) : streamResponse([rpcEnvelope(1, "0x1")]);
  });
  equal([retried.ok, attempts, retryContext.budget.retries], [true, 2, 1], "retry remains bounded and succeeds");

  const singleCapContext = { caps: { ...runner.CAPS, maxResponseBytes: 5, retriesPerRequest: 0 },
    budget: new runner.Budget({ ...runner.CAPS, maxResponseBytes: 5 }), nextId: 0 };
  const oversizedResponse = streamResponse(["1234", "5678"]);
  await rejectsCode(() => runner.rpcRequest({ url: "mock://family", family: "F1" }, "eth_chainId", [], singleCapContext,
    async () => oversizedResponse), "BUDGET_EXHAUSTED_SINGLE_RESPONSE_BYTES", "stream aborts at per-response cap");
  equal(oversizedResponse.wasCancelled(), true, "oversized stream reader cancelled");
  const aggregateCaps = { ...runner.CAPS, maxAggregateResponseBytes: 5, retriesPerRequest: 0 };
  const aggregateContext = { caps: aggregateCaps, budget: new runner.Budget(aggregateCaps), nextId: 0 };
  const aggregateResponse = streamResponse(["123", "456"]);
  await rejectsCode(() => runner.rpcRequest({ url: "mock://family", family: "F1" }, "eth_chainId", [], aggregateContext,
    async () => aggregateResponse), "BUDGET_EXHAUSTED_AGGREGATE_RESPONSE_BYTES", "stream aborts at aggregate cap");
  equal(aggregateResponse.wasCancelled(), true, "aggregate-overflow stream reader cancelled");
  await rejectsCode(() => runner.readResponseBodyLimited({ arrayBuffer: async () => Buffer.alloc(100) },
    { caps: runner.CAPS, budget: new runner.Budget() }, new AbortController()), "STREAMING_BODY_REQUIRED",
  "non-stream full-body fallback hard-fails before allocation");

  const getterContext = { caps: { ...runner.CAPS, retriesPerRequest: 0 }, budget: new runner.Budget(), nextId: 0 };
  const encodedSupply = runner.ABI.tokenInterface.encodeFunctionResult("totalSupply", [123n]);
  const getter = await runner.callDecoded({ url: "mock://family", family: "F1" }, ADDRESS_A, runner.ABI.tokenInterface,
    "totalSupply", [], 10n, getterContext, async () => streamResponse([rpcEnvelope(1, encodedSupply)]));
  equal(BigInt(getter[0]), 123n, "actual token ABI getter decodes");

  const tokenEvents = new Interface(["event ControllerUpdated(address indexed controller,bool registered)"]);
  const encodedController = tokenEvents.encodeEventLog(tokenEvents.getEvent("ControllerUpdated"), [ADDRESS_A, true]);
  const rawControllerLog = {
    address: ADDRESS_A,
    blockNumber: "0xa",
    transactionIndex: "0x0",
    logIndex: "0x0",
    blockHash: HASH_A,
    transactionHash: HASH_B,
    data: encodedController.data,
    topics: encodedController.topics,
    removed: false
  };
  const parsedController = runner.validateLog(rawControllerLog, new Set([ADDRESS_A]), new Set([encodedController.topics[0].toLowerCase()]), 0n, 10n);
  equal(runner.decodeRoleLog(parsedController, "token").label, "ControllerUpdated", "per-role ABI event decodes");
  throwsCode(() => runner.decodeRoleLog(parsedController, "controller"), "CROSS_ROLE_TOPIC", "cross-role topic rejected");
  const malformedController = { ...parsedController, data: "0x" };
  throwsCode(() => runner.decodeRoleLog(malformedController, "token"), "MALFORMED_EVENT_DATA", "malformed event data fatal");

  const canonicalCaps = { ...runner.CAPS, retriesPerRequest: 0 };
  const canonicalContext = { caps: canonicalCaps, budget: new runner.Budget(canonicalCaps), nextId: 0, canonicalHeaders: new Map() };
  const canonicalOk = await runner.verifyCanonicalEventBlocks({ url: "mock://family", family: "F1" }, [parsedController], canonicalContext,
    async () => streamResponse([rpcEnvelope(1, { number: "0xa", hash: HASH_A, timestamp: "0x1" })]));
  equal(canonicalOk, true, "event-bearing block header hash canonical");
  const mismatchContext = { caps: canonicalCaps, budget: new runner.Budget(canonicalCaps), nextId: 0, canonicalHeaders: new Map() };
  const canonicalMismatch = await runner.verifyCanonicalEventBlocks({ url: "mock://family", family: "F1" }, [parsedController], mismatchContext,
    async () => streamResponse([rpcEnvelope(1, { number: "0xa", hash: HASH_B, timestamp: "0x1" })]));
  equal(canonicalMismatch, false, "event block hash mismatch rejects history completeness");
  const conflictingSameBlock = [{ ...parsedController, blockHash: HASH_A }, { ...parsedController, blockHash: HASH_B, logIndex: 1n }];
  const conflictContext = { caps: canonicalCaps, budget: new runner.Budget(canonicalCaps), nextId: 0, canonicalHeaders: new Map() };
  const conflictingAccepted = await runner.verifyCanonicalEventBlocks({ url: "mock://family", family: "F1" }, conflictingSameBlock,
    conflictContext, async () => { throw new Error("header must not be queried"); });
  equal(conflictingAccepted, false, "conflicting hashes for one block number rejected before header lookup");
  const uniqueCaps = { ...runner.CAPS, maxUniqueEventBlocks: 0, retriesPerRequest: 0 };
  const uniqueContext = { caps: uniqueCaps, budget: new runner.Budget(uniqueCaps), nextId: 0, canonicalHeaders: new Map() };
  await rejectsCode(() => runner.verifyCanonicalEventBlocks({ url: "mock://family", family: "F1" }, [parsedController], uniqueContext,
    async () => streamResponse([])), "BUDGET_EXHAUSTED_UNIQUE_EVENT_BLOCKS", "unique event block budget enforced");

  equal(runner.selectPin(observations()).families, ["F1", "F2"], "two distinct families agree on finalized pin");
  const sameFamily = observations().slice(0, 2).map((row) => ({ ...row, family: "F1" }));
  equal(runner.selectPin(sameFamily).promotable, false, "same family cannot satisfy threshold");
  const hashMismatch = observations().slice(0, 2);
  hashMismatch[1].header.hash = HASH_B;
  equal(runner.selectPin(hashMismatch).promotable, false, "finalized hash mismatch rejected");
  const numberMismatch = observations().slice(0, 2);
  numberMismatch[1].header.number += 1n;
  equal(runner.selectPin(numberMismatch).promotable, false, "finalized number mismatch rejected");
  equal(runner.terminalPinMatches(observations()[0].header, observations()[1].header), true, "terminal exact pin accepted");
  equal(runner.terminalPinMatches(observations()[0].header, { ...observations()[1].header, hash: HASH_B }), false,
    "terminal hash mismatch rejected");
  equal(runner.terminalPinMatches(observations()[0].header, { ...observations()[1].header, number: 2n }), false,
    "terminal number mismatch rejected");
  equal(runner.selectPin(hashMismatch).bestQualifiedFamilyCount, 1, "best partial family count retained without identity");

  const leaks = [
    [{ value: "https://rpc.invalid" }, "OUTPUT_URL_LEAK"],
    [{ hostname: "host.invalid" }, "OUTPUT_IDENTITY_LEAK"],
    [{ providerIdentity: "provider-a" }, "OUTPUT_IDENTITY_LEAK"],
    [{ providerHash: HASH_A }, "OUTPUT_IDENTITY_LEAK"],
    [{ rawResponse: "body" }, "OUTPUT_IDENTITY_LEAK"],
    [{ transactionHash: HASH_A }, "OUTPUT_IDENTITY_LEAK"],
    [{ calldata: "0x1234" }, "OUTPUT_IDENTITY_LEAK"],
    [{ arbitrary: ADDRESS_A }, "OUTPUT_ADDRESS_LEAK"]
  ];
  for (const [value, code] of leaks) throwsCode(() => runner.sanitizeCapture(value), code, `${code} enforced`);
  equal(runner.sanitizeCapture({ runtimeHash: HASH_A, roleLabel: "controller", count: 2, complete: true }),
    { runtimeHash: HASH_A, roleLabel: "controller", count: 2, complete: true }, "non-user runtime hash and aggregates allowed");

  const failed = runner.failClosedCapture("SOURCE_RUNTIME_LINEAGE_INCOMPLETE", new runner.Budget().summary());
  equal(Object.values(failed.promotionGates), [null, null, null, null, null, null], "incomplete lineage nulls every promotion gate");
  equal(Object.values(failed.operationalGates), [0, 0, false, false], "operational gates closed");

  const baseConditions = { finalityComplete: true, historyComplete: true, stateAgreement: true, registryAgreement: true,
    exactLineage: null, supplyReconciled: true };
  const usefulFacts = { vaultLineage: { usefulPartialLineage: true, partialLineageCompleteCount: 1 },
    discovery: { dualFamilyMembershipAgreement: true } };
  const partial = runner.buildCaptureResult(baseConditions, new runner.Budget().summary(), usefulFacts);
  equal([partial.status, partial.resultPromoted, partial.promotionGates.currentAffectedPositionExposure],
    ["PARTIAL_USEFUL_LINEAGE_CAPTURED_EXPOSURE_AND_ECONOMIC_GATES_NULL", false, null], "useful partial lineage branch");
  const emptyLineage = runner.buildCaptureResult(baseConditions, new runner.Budget().summary(), {
    vaultLineage: { usefulPartialLineage: false, partialLineageCompleteCount: 0 }, discovery: { dualFamilyMembershipAgreement: true }
  });
  equal([emptyLineage.status, emptyLineage.reasonCode],
    ["INCOMPLETE_ALL_EXPOSURE_AND_ECONOMIC_GATES_NULL", "USEFUL_PARTIAL_LINEAGE_NOT_ESTABLISHED"],
  "empty lineage cannot receive useful partial wording");
  const complete = runner.buildCaptureResult({ ...baseConditions, exactLineage: true }, new runner.Budget().summary(), usefulFacts);
  equal([complete.status, complete.resultPromoted, complete.promotionGates.runtimeLineageComplete],
    ["COMPLETE_READ_ONLY_LINEAGE_AND_HISTORY_CAPTURED", true, true], "promotable exact lineage branch reachable");
  const failedHistory = runner.buildCaptureResult({ ...baseConditions, historyComplete: false }, new runner.Budget().summary(), usefulFacts);
  equal([failedHistory.status, failedHistory.reasonCode],
    ["INCOMPLETE_ALL_EXPOSURE_AND_ECONOMIC_GATES_NULL", "HISTORY_INCOMPLETE_OR_MISMATCH"], "history failure branch closes gates");
  equal(runner.reconcileGlobalSupply(10n, 7n, { complete: true, shares: new Map([[ADDRESS_A, 3n]]) }, true),
    { allControllersIncluded: true, reconciled: true, controllerCount: 2 }, "main plus all auxiliary controllers reconcile supply");
  equal(runner.reconcileGlobalSupply(10n, 10n, { complete: false, shares: new Map() }, false).reconciled, null,
    "global supply reconciliation withheld without every controller");
  const protocolLeft = { runtime: [{ role: "controller", runtimeHash: HASH_A }], raw: { totalSupply: 10n, totalShares: 7n } };
  const protocolRight = { runtime: [{ role: "controller", runtimeHash: HASH_A }], raw: { totalSupply: 11n, totalShares: 7n } };
  equal(runner.protocolObservationsExactlyMatch(protocolLeft, protocolRight), false,
    "exact in-memory numeric mismatch is not hidden by sanitized predicates");
  equal(runner.protocolObservationsExactlyMatch(protocolLeft, clone({ runtime: protocolLeft.runtime,
    raw: { totalSupply: "10", totalShares: "7" } })), false, "numeric types compare exactly");
  const vaultLineageA = [{ internal: { vault: ADDRESS_A, implementation: ADDRESS_A, vaultId: HASH_A },
    sanitized: { partialLineageComplete: true } }];
  const vaultLineageB = [{ internal: { vault: ADDRESS_A, implementation: `0x${"22".repeat(20)}`, vaultId: HASH_A },
    sanitized: { partialLineageComplete: true } }];
  equal(runner.vaultLineageExactlyMatches(vaultLineageA, vaultLineageB), false,
    "exact vault implementation identity mismatch rejected before sanitization");
  const dualObservations = [{ raw: { totalSupply: 10n, totalShares: 7n } }, { raw: { totalSupply: 10n, totalShares: 7n } }];
  const auxLeft = { complete: true, shares: new Map([[ADDRESS_A, 3n]]) };
  const auxRight = { complete: true, shares: new Map([[ADDRESS_A, 4n]]) };
  equal(runner.reconcileDualFamilySupply(dualObservations, [auxLeft, auxRight], true).reconciled, null,
    "auxiliary-controller share mismatch keeps global reconciliation null");
  equal(runner.reconcileDualFamilySupply(dualObservations, [auxLeft, { complete: true, shares: new Map([[ADDRESS_A, 3n]]) }],
    true).reconciled, true, "exact dual-family auxiliary shares permit reconciliation");
  const overrunBudget = { ...new runner.Budget().summary(), elapsedWithinCap: false, allWithinCaps: false };
  equal(runner.buildCaptureResult({ ...baseConditions, exactLineage: true }, overrunBudget, usefulFacts).reasonCode,
    "BUDGET_NOT_WITHIN_CAPS", "post-work elapsed overrun blocks every positive classification");
  equal([runner.isNonzeroAddress(ADDRESS_A), runner.isNonzeroAddress("0x0000000000000000000000000000000000000000")],
    [true, false], "strict nonzero address predicate");

  const tempParent = path.join(os.tmpdir(), "opencode");
  check(fs.existsSync(tempParent), "approved temporary parent exists");
  const tempDir = fs.mkdtempSync(path.join(tempParent, "ostoken-capture-test-"));
  try {
    const ledger = path.join(tempDir, "ledger.json");
    const authorization = { ledgerPath: ledger, approvalId: valid.expected.approvalId, approvalCommitment: valid.approval.approvalCommitment };
    runner.consumeApprovalAtomically(authorization);
    throwsCode(() => runner.consumeApprovalAtomically(authorization), "EEXIST", "concurrent wx/replay consumption rejected");
    const inventory = path.join(tempDir, "inventory.txt");
    fs.writeFileSync(inventory, "x".repeat(20), "utf8");
    const inventoryCaps = { ...runner.CAPS, maxInventoryBytes: 10 };
    const inventoryContext = { caps: inventoryCaps, budget: new runner.Budget(inventoryCaps), nextId: 0 };
    throwsCode(() => runner.loadInventoryAuthorized(inventoryContext, inventory), "INVENTORY_BYTES_EXCEEDED",
      "inventory byte cap fails after consumption");
    const failArtifact = path.join(tempDir, "capture.json");
    const inventoryFailure = runner.sanitizeCapture(runner.failClosedCapture("INVENTORY_PROCESSING_FAILED", inventoryContext.budget.summary()));
    fs.writeFileSync(failArtifact, `${JSON.stringify(inventoryFailure)}\n`, { flag: "wx" });
    equal([fs.existsSync(ledger), JSON.parse(fs.readFileSync(failArtifact, "utf8")).reasonCode],
      [true, "INVENTORY_PROCESSING_FAILED"], "consumed inventory failure persists sanitized fail-closed artifact");
    const lineInventory = path.join(tempDir, "lines.txt");
    fs.writeFileSync(lineInventory, "a\nb\nc\n", "utf8");
    const lineCaps = { ...runner.CAPS, maxInventoryLines: 2 };
    throwsCode(() => runner.loadInventoryAuthorized({ caps: lineCaps, budget: new runner.Budget(lineCaps), nextId: 0 }, lineInventory),
      "INVENTORY_LINES_EXCEEDED", "inventory line cap enforced");

    const e2eLedger = path.join(tempDir, "e2e-ledger.json");
    const e2eOutput = path.join(tempDir, "e2e-capture.json");
    const e2eAuthorization = { ledgerPath: e2eLedger, outputPath: e2eOutput, approvalId: valid.expected.approvalId,
      approvalCommitment: valid.approval.approvalCommitment };
    const e2e = await runner.runCapture({ capture: true }, {
      validateApproval: () => e2eAuthorization,
      loadLocalBindings: () => ({}),
      loadInventory: () => { throw new Error("INVENTORY_BYTES_EXCEEDED"); }
    });
    equal([fs.existsSync(e2eLedger), fs.existsSync(e2eOutput), e2e.reasonCode], [true, true, "INVENTORY_PROCESSING_FAILED"],
      "end-to-end runCapture persists fail-closed output after ledger consumption");

    const timedLedger = path.join(tempDir, "timed-ledger.json");
    const timedOutput = path.join(tempDir, "timed-capture.json");
    let nowCalls = 0;
    const timed = await runner.runCapture({ capture: true }, {
      caps: { ...runner.CAPS, maxElapsedMs: 10 },
      now: () => { nowCalls += 1; return nowCalls < 4 ? 0 : 100; },
      validateApproval: () => ({ ledgerPath: timedLedger, outputPath: timedOutput, approvalId: valid.expected.approvalId,
        approvalCommitment: valid.approval.approvalCommitment }),
      loadLocalBindings: () => ({}),
      loadInventory: () => { throw new Error("INVENTORY_BYTES_EXCEEDED"); }
    });
    equal([timed.reasonCode, timed.budget.allWithinCaps], ["BUDGET_NOT_WITHIN_CAPS", false],
      "elapsed overrun immediately before output replaces earlier positive or partial wording");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const closure = runner.discoverSourceClosure();
  check(closure.includes("deployments/mainnet.json") && closure.includes("contracts/tokens/OsToken.sol") &&
    closure.some((value) => value.includes("openzeppelin-contracts")), "deployment seeds and recursive source dependencies bound");
  equal(new Set(closure).size, closure.length, "source closure deduplicated");

  const source = fs.readFileSync(path.join(__dirname, "critical-stakewise-v3-ostoken-mainnet-runner.js"), "utf8");
  const mainSource = source.slice(source.indexOf("async function main"));
  check(mainSource.indexOf("if (!args.capture)") < mainSource.indexOf("runCapture(args)"), "check-only exits before capture workflow");
  const captureSource = source.slice(source.indexOf("async function runCapture"));
  check(captureSource.indexOf("dependencies.validateApproval || validateApproval") <
    captureSource.indexOf("dependencies.consumeApproval || consumeApprovalAtomically"),
    "approval validated before single-use consumption");
  check(captureSource.indexOf("dependencies.consumeApproval || consumeApprovalAtomically") <
    captureSource.indexOf("dependencies.loadInventory || loadInventoryAuthorized"),
    "approval consumed before endpoint inventory read");
  check(source.includes("function loadInventoryAuthorized(context") &&
    captureSource.includes("dependencies.loadInventory || loadInventoryAuthorized"),
  "bounded inventory loader is reached through the capture-only dependency boundary");

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    fixtureClasses: fixture.fixtureClasses.length,
    sourceClosureFiles: closure.length,
    networkReads: 0,
    inventoryReads: 0,
    liveCaptureExecuted: false,
    approvalCreated: false
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
