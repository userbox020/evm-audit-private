#!/usr/bin/env node
"use strict";

const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { keccak256 } = require("ethers");
const runner = require("./critical-uniswapx-v2-empty-batch-opening-eth-deployment-economics-step3-runner.js");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", `${runner.STEM}-fixtures.json`), "utf8"));
const HASH_A = `0x${"aa".repeat(32)}`;
let checks = 0;
const equal = (actual, expected, message) => { checks += 1; assert.deepStrictEqual(actual, expected, `check ${checks}: ${message}`); };
const check = (value, message) => { checks += 1; assert.ok(value, `check ${checks}: ${message}`); };
const throws = (fn, code, message) => { checks += 1; assert.throws(fn, new RegExp(code, "u"), `check ${checks}: ${message}`); };
const rejects = async (fn, code, message) => { checks += 1; await assert.rejects(fn, new RegExp(code, "u"), `check ${checks}: ${message}`); };

function response(chunks, status = 200) {
  let index = 0; let cancelled = false;
  return { status, redirected: false, headers: { get: () => null }, body: { getReader: () => ({
    read: async () => index < chunks.length ? { done: false, value: Buffer.from(chunks[index++]) } : { done: true },
    cancel: async () => { cancelled = true; }
  }) }, cancelled: () => cancelled };
}
const envelope = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });

function approval(now) {
  const c = runner.commitments();
  const expected = { approvalId: "uxv2-step3-0123456789abcdef0123456789abcdef", runnerSha256: HASH_A,
    packageManifestSha256: HASH_A, packageAggregateSha256: HASH_A, evidenceBinding: HASH_A, proposalCommitment: HASH_A,
    reviewMaterialManifestSha256: HASH_A, ...c };
  const payload = { approvalId: expected.approvalId, findingId: runner.FINDING_ID, chainId: 1,
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), authorizedCaptureCount: 1,
    fixedApprovalPath: runner.FIXED_APPROVAL_REL, fixedOutputPath: runner.FIXED_OUTPUT_REL,
    globalConsumptionLedger: runner.LEDGER_REL, endpointInventoryReadAuthorized: true, transactionsAuthorized: false,
    traceAuthorized: false, forkAuthorized: false, runnerSha256: expected.runnerSha256,
    packageManifestSha256: expected.packageManifestSha256, packageAggregateSha256: expected.packageAggregateSha256,
    evidenceBinding: expected.evidenceBinding, proposalCommitment: expected.proposalCommitment,
    reviewMaterialManifestSha256: expected.reviewMaterialManifestSha256, candidateCommitment: c.candidateCommitment,
    senderCommitment: c.senderCommitment, calldataCommitment: c.calldataCommitment, runtimeCommitment: c.runtimeCommitment,
    methodsCommitment: c.methodsCommitment, capsCommitment: c.capsCommitment,
    economicPolicyCommitment: c.economicPolicyCommitment, allowedMethods: [...runner.ALLOWED_METHODS].sort(),
    approvalAuthenticityAssumption: "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM" };
  return { expected, envelope: { schemaVersion: 2, state: "AUTHORIZED", approvalPayload: payload,
    approvalCommitment: runner.bytes32Commitment(payload) } };
}

async function main() {
  equal(FIXTURE.fixtureClasses.length, 37, "all fixture classes listed");
  for (const name of ["approval-expiry", "wx-concurrency", "family-threshold", "runtime-hash-mismatch",
    "below-hard-floor-balance", "estimate-divergence-max-selection", "streaming-required", "economic-rounding",
    "post-consumption-failure-persistence"]) check(FIXTURE.fixtureClasses.includes(name), `fixture ${name}`);

  const preflight = runner.dryPreflight();
  equal(preflight.status, "REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED", "preflight status");
  equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "check-only zero effects");
  equal(preflight.methods.allowed, ["eth_call", "eth_chainId", "eth_estimateGas", "eth_getBalance", "eth_getBlockByNumber", "eth_getCode"], "exact allowlist");
  equal([preflight.providerPolicy.requiredHostnameDistinctFamilies, preflight.providerPolicy.backendIndependenceProven], [2, false], "hostname only diversity");
  equal([preflight.caps.maxRequestsPerFamily, preflight.caps.maxTotalRequests, preflight.caps.retriesPerRequest], [8, 16, 0], "request caps");
  equal([preflight.economicPolicy.minChargedGas, preflight.economicPolicy.gasBufferNumerator], [21830, 120], "economic policy fixed");
  const watched = [runner.FIXED_APPROVAL_REL, runner.LEDGER_REL, runner.FIXED_OUTPUT_REL].map((p) => path.join(ROOT, ...p.split("/")));
  const before = watched.map(fs.existsSync);
  const child = cp.spawnSync(process.execPath, [path.join(__dirname, `${runner.STEM}-runner.js`), "--check-only"], { cwd: ROOT, encoding: "utf8", env: {} });
  equal([child.status, child.stderr], [0, ""], "check-only command passes");
  equal(JSON.parse(child.stdout), preflight, "check-only deterministic");
  equal(watched.map(fs.existsSync), before, "check-only creates nothing");
  throws(() => runner.parseArgs(["node", "runner", "--capture-once", "--check-only"]), "MODE_CONFLICT", "mode conflict");
  throws(() => runner.parseArgs(["node", "runner", "--output", "x"]), "UNKNOWN_ARGUMENT", "fixed output");

  const now = Date.parse("2026-08-01T12:00:00Z"); const valid = approval(now);
  equal(runner.validateApprovalEnvelope(valid.envelope, valid.expected, now, false).approvalId, valid.expected.approvalId, "approval validates");
  throws(() => runner.validateApprovalEnvelope(valid.envelope, valid.expected, now, true), "APPROVAL_ALREADY_CONSUMED", "replay rejected");
  const expired = JSON.parse(JSON.stringify(valid.envelope)); expired.approvalPayload.expiresAt = new Date(now - 1).toISOString();
  expired.approvalCommitment = runner.bytes32Commitment(expired.approvalPayload);
  throws(() => runner.validateApprovalEnvelope(expired, valid.expected, now, false), "APPROVAL_WINDOW_INVALID", "expiry rejected");
  const pathChanged = JSON.parse(JSON.stringify(valid.envelope)); pathChanged.approvalPayload.fixedOutputPath += ".x";
  pathChanged.approvalCommitment = runner.bytes32Commitment(pathChanged.approvalPayload);
  throws(() => runner.validateApprovalEnvelope(pathChanged, valid.expected, now, false), "APPROVAL_BINDING_INVALID", "path bound");
  const hashChanged = JSON.parse(JSON.stringify(valid.envelope)); hashChanged.approvalPayload.runtimeCommitment = HASH_A;
  hashChanged.approvalCommitment = runner.bytes32Commitment(hashChanged.approvalPayload);
  throws(() => runner.validateApprovalEnvelope(hashChanged, valid.expected, now, false), "APPROVAL_BINDING_INVALID", "runtime hash bound");
  const extra = JSON.parse(JSON.stringify(valid.envelope)); extra.approvalPayload.extra = false;
  throws(() => runner.validateApprovalEnvelope(extra, valid.expected, now, false), "APPROVAL_PAYLOAD_SCHEMA", "extra field rejected");

  equal(runner.headersEqual({ number: 1n, hash: HASH_A, timestamp: 2n, baseFee: 3n },
    { number: 1n, hash: HASH_A, timestamp: 2n, baseFee: 3n }), true, "pin exact agreement");
  equal(runner.headersEqual({ number: 1n, hash: HASH_A, timestamp: 2n, baseFee: 3n },
    { number: 1n, hash: HASH_A, timestamp: 2n, baseFee: 4n }), false, "base fee disagreement");
  equal(runner.evaluateFixedState([{ code: "0x", balance: 1n }, { code: "0x", balance: 1n }], 1n).reason,
    "RUNTIME_EMPTY_OR_MISMATCH", "empty runtime stops");
  equal(runner.evaluateFixedState([{ code: "0x12", balance: 1n }, { code: "0x34", balance: 1n }], 1n).reason,
    "RUNTIME_EMPTY_OR_MISMATCH", "runtime disagreement stops");
  equal(runner.evaluateBalance(2n, 3n, 1n).reason, "BALANCE_MISMATCH", "balance disagreement stops");
  equal(runner.evaluateBalance(0n, 0n, 1n).reason, "ZERO_BALANCE", "zero balance stops");
  equal(runner.evaluateBalance(21830n, 21830n, 1n).reason, "BALANCE_AT_OR_BELOW_HARD_FLOOR", "hard floor stops inclusive");
  equal(runner.evaluateBalance(21831n, 21831n, 1n).ok, true, "above hard floor continues");

  const economics = runner.calculateEconomics(1000000000000000000n, 30000n, 40000n, 10000000000n);
  equal(economics.gasUsed, 48000n, "divergent estimates use larger with ceil buffer");
  equal(economics.stressedBaseFee, 11250000000n, "base fee stress ceil");
  equal(economics.priorityCompetition, 2812500000n, "priority max quarter");
  check(economics.positive, "positive economics");
  equal(runner.calculateEconomics(1n, 21830n, 21830n, 1n).positive, false, "nonpositive economics");
  const positive = runner.positiveResult({ openingBalanceWei: "100", vaultLineage: null }, { ...economics, positive: true },
    new runner.Budget().summary());
  equal([positive.status, positive.operationalGates.routePositive, positive.operationalGates.executableNow],
    ["POSITIVE_CONSERVATIVE_NET_DIAGNOSTIC_ONLY", 0, 0], "positive capture remains operationally closed");

  const budget = new runner.Budget({ ...runner.CAPS, maxRequestsPerFamily: 1 }); budget.consume("F1", "eth_chainId");
  throws(() => budget.consume("F1", "eth_getCode"), "BUDGET_EXHAUSTED_FAMILY_REQUESTS", "family request cap");
  const totalBudget = new runner.Budget({ ...runner.CAPS, maxTotalRequests: 0 });
  throws(() => totalBudget.consume("F1", "eth_chainId"), "BUDGET_EXHAUSTED_TOTAL_REQUESTS", "total request cap");
  let clock = 0; const timed = new runner.Budget({ ...runner.CAPS, maxElapsedMs: 1 }, () => { clock += 2; return clock; });
  throws(() => timed.checkTime(), "BUDGET_EXHAUSTED_TIME", "elapsed cap");
  throws(() => new runner.Budget().consume("F1", "eth_getLogs"), "METHOD_FORBIDDEN", "logs forbidden");

  const context = { caps: runner.CAPS, budget: new runner.Budget(), nextId: 0 };
  const body = envelope(1, "0x1"); const streamed = await runner.rpcRequest({ url: "mock://", family: "F1" }, "eth_chainId", [], context,
    async () => response([body.slice(0, 5), body.slice(5)]));
  equal([streamed.ok, streamed.result], [true, "0x1"], "streaming response");
  await rejects(() => runner.readStreamed({ arrayBuffer: async () => Buffer.alloc(1) },
    { caps: runner.CAPS, budget: new runner.Budget() }, new AbortController()), "STREAMING_BODY_REQUIRED", "full-body fallback forbidden");
  const smallCaps = { ...runner.CAPS, maxResponseBytes: 2 }; const oversized = response(["123"]);
  await rejects(() => runner.readStreamed(oversized, { caps: smallCaps, budget: new runner.Budget(smallCaps) }, new AbortController()),
    "BUDGET_EXHAUSTED_SINGLE_RESPONSE_BYTES", "single body cap");
  equal(oversized.cancelled(), true, "oversized stream cancelled");
  const rejectedHttp = response(["discard"], 500);
  const httpFailure = await runner.rpcRequest({ url: "mock://", family: "F1" }, "eth_chainId", [],
    { caps: runner.CAPS, budget: new runner.Budget(), nextId: 0 }, async () => rejectedHttp);
  equal([httpFailure.error, rejectedHttp.cancelled()], ["HTTP_FAILURE", true], "non-2xx body cancelled before return");
  const aggregateCaps = { ...runner.CAPS, maxAggregateResponseBytes: 2 };
  await rejects(() => runner.readStreamed(response(["123"]), { caps: aggregateCaps, budget: new runner.Budget(aggregateCaps) }, new AbortController()),
    "BUDGET_EXHAUSTED_AGGREGATE_RESPONSE_BYTES", "aggregate body cap");
  equal(runner.parseEnvelope(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "insufficient funds for gas" } }), 1).error,
    "ESTIMATE_FUNDING_CHECK", "estimate funding requirement classified without persistence");
  equal(runner.parseEnvelope(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), 1).result, "0x", "empty call result accepted");
  equal(runner.parseEnvelope(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x12" }), 1).result, "0x12", "nonempty call observable for rejection");
  equal(runner.evaluateCallResults([{ ok: true, result: "0x" }, { ok: true, result: "0x" }]).ok, true,
    "both empty call results required");
  equal(runner.evaluateCallResults([{ ok: false }, { ok: true, result: "0x" }]).reason, "CALL_REVERT_OR_NONEMPTY",
    "call revert stops");
  equal(runner.evaluateCallResults([{ ok: true, result: "0x12" }, { ok: true, result: "0x" }]).reason,
    "CALL_REVERT_OR_NONEMPTY", "nonempty call result stops");
  equal(runner.evaluateEstimateResults([{ ok: true, result: "0x7530" }, { ok: true, result: "0x9c40" }]).estimates,
    [30000n, 40000n], "divergent estimates retained for max policy");
  equal(runner.evaluateEstimateResults([{ ok: false, error: "RPC_ERROR" }, { ok: true, result: "0x9c40" }]).reason,
    "ESTIMATE_FAILED", "estimate failure stops");
  equal(runner.evaluateEstimateResults([{ ok: false, error: "ESTIMATE_FUNDING_CHECK" }, { ok: true, result: "0x9c40" }]).fundingQualificationRequired,
    true, "sender balance diagnostic only signaled by funding-check estimate failure");

  throws(() => runner.sanitizeOutput({ url: "https://invalid" }), "OUTPUT_ADDRESS_OR_URL_LEAK", "URL leak rejected");
  throws(() => runner.sanitizeOutput({ value: "0x1111111111111111111111111111111111111111" }), "OUTPUT_ADDRESS_OR_URL_LEAK", "address leak rejected");
  throws(() => runner.sanitizeOutput({ calldata: "0x12" }), "OUTPUT_FORBIDDEN_KEY", "calldata leak rejected");
  throws(() => runner.sanitizeOutput({ transactionHash: HASH_A }), "OUTPUT_FORBIDDEN_KEY", "tx hash leak rejected");
  equal(runner.sanitizeOutput({ candidateRole: "fixed", candidateCommitment: HASH_A, count: 1 }),
    { candidateRole: "fixed", candidateCommitment: HASH_A, count: 1 }, "commitment and role accepted");

  const tempParent = path.join(os.tmpdir(), "opencode"); check(fs.existsSync(tempParent), "approved temp parent");
  const dir = fs.mkdtempSync(path.join(tempParent, "ux-step3-"));
  try {
    const ledger = path.join(dir, "ledger.json"); const auth = { ledgerPath: ledger, approvalId: valid.expected.approvalId,
      approvalCommitment: valid.envelope.approvalCommitment };
    runner.consumeApproval(auth); throws(() => runner.consumeApproval(auth), "EEXIST", "wx concurrency/replay");
    const inventory = path.join(dir, "inventory.txt"); fs.writeFileSync(inventory, "x".repeat(20));
    const inventoryCaps = { ...runner.CAPS, maxInventoryBytes: 10 };
    throws(() => runner.loadInventoryAuthorized({ caps: inventoryCaps, budget: new runner.Budget(inventoryCaps) }, inventory),
      "INVENTORY_BYTES_EXCEEDED", "inventory cap");
    const entriesInventory = path.join(dir, "entries.txt");
    fs.writeFileSync(entriesInventory, Array.from({ length: 17 }, (_, index) => `https://family${index}.invalid`).join("\n"));
    const entryCaps = { ...runner.CAPS, maxFamilies: 20 };
    equal(runner.loadInventoryAuthorized({ caps: entryCaps, budget: new runner.Budget(entryCaps) }, entriesInventory).length,
      16, "inventory entry cap stops at sixteen");

    const e2eLedger = path.join(dir, "e2e-ledger.json"); const output = path.join(dir, "capture.json");
    const captured = await runner.runCapture({ capture: true }, {
      validateApproval: () => ({ ledgerPath: e2eLedger, outputPath: output, approvalId: valid.expected.approvalId,
        approvalCommitment: valid.envelope.approvalCommitment }),
      loadInventory: () => { throw new Error("INVENTORY_FAILURE"); }
    });
    equal([fs.existsSync(e2eLedger), fs.existsSync(output), captured.status, captured.reasonCode],
      [true, true, "INCOMPLETE_FAIL_CLOSED", "CAPTURE_FAILURE"], "post-consumption failure persists sanitized artifact");
    equal(runner.sanitizeOutput(JSON.parse(fs.readFileSync(output, "utf8"))).status, "INCOMPLETE_FAIL_CLOSED", "persisted artifact leak guard");

    const familyFailureLedger = path.join(dir, "family-ledger.json"); const familyOutput = path.join(dir, "family-output.json");
    const familyFailure = await runner.runCapture({ capture: true }, {
      validateApproval: () => ({ ledgerPath: familyFailureLedger, outputPath: familyOutput, approvalId: valid.expected.approvalId,
        approvalCommitment: valid.envelope.approvalCommitment }),
      loadInventory: () => [], qualify: async () => ({ ok: false, reason: "FAMILY_THRESHOLD", rows: [] })
    });
    equal(familyFailure.reasonCode, "FAMILY_THRESHOLD", "family threshold fail closed");

    async function mockedCapture(name, options = {}) {
      const fakeCode = "0x60016000"; const pinHash = HASH_A;
      const pin = { number: "0x100", hash: pinHash, timestamp: "0x200", baseFeePerGas: "0x3b9aca00" };
      const records = [];
      const fetchImpl = async (url, request) => {
        const body = JSON.parse(request.body); const family = url.endsWith("f1") ? "F1" : "F2";
        records.push({ family, method: body.method, params: body.params });
        let result;
        if (body.method === "eth_chainId") result = "0x1";
        else if (body.method === "eth_getBlockByNumber") result = { ...pin,
          hash: options.terminalMismatch && body.params[0] !== "finalized" && family === "F2" ? `0x${"bb".repeat(32)}` : pinHash };
        else if (body.method === "eth_getCode") result = body.params[0].toLowerCase() === runner.FIXED_SCOPE.sender
          ? (options.senderCode || "0x") : fakeCode;
        else if (body.method === "eth_getBalance") result = `0x${BigInt(options.balance === undefined
          ? 1000000000000000000n : options.balance).toString(16)}`;
        else if (body.method === "eth_call") result = options.callResult === undefined ? "0x" : options.callResult;
        else if (body.method === "eth_estimateGas") {
          if (options.fundingFailure && family === "F1") return response([JSON.stringify({ jsonrpc: "2.0", id: body.id,
            error: { code: -32000, message: "insufficient funds for gas" } })]);
          result = family === "F1" ? "0x7530" : "0x9c40";
        }
        else throw new Error("unexpected method");
        return response([envelope(body.id, result)]);
      };
      const ledgerPath = path.join(dir, `${name}-ledger.json`); const outputPath = path.join(dir, `${name}-capture.json`);
      const value = await runner.runCapture({ capture: true }, {
        validateApproval: () => ({ ledgerPath, outputPath, approvalId: valid.expected.approvalId,
          approvalCommitment: valid.envelope.approvalCommitment }),
        loadInventory: () => [{ url: "mock://f1", family: "F1" }, { url: "mock://f2", family: "F2" }],
        fetchImpl,
        runtimeExpectation: { bytes: 4, hash: keccak256(fakeCode) }
      });
      return { value, records, outputPath };
    }

    const success = await mockedCapture("success");
    equal(success.value.status, "POSITIVE_CONSERVATIVE_NET_DIAGNOSTIC_ONLY", "end-to-end positive diagnostic status");
    equal([success.value.facts.fixedPinNumber, success.value.facts.fixedPinHash, success.value.facts.fixedPinTimestamp,
      success.value.facts.fixedPinBaseFeeWei, success.value.facts.senderCodeAgreement, success.value.facts.terminalRecheckMatched],
    ["256", HASH_A, "512", "1000000000", true, true], "sanitized fixed-state evidence persisted");
    equal([success.value.facts.estimateA, success.value.facts.estimateB, success.value.facts.selectedMaxEstimate],
      ["30000", "40000", "40000"], "both estimates and selected maximum persisted");
    const expectedOrder = ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getBalance", "eth_getCode",
      "eth_call", "eth_estimateGas", "eth_getBlockByNumber"];
    for (const family of ["F1", "F2"]) equal(success.records.filter((row) => row.family === family).map((row) => row.method),
      expectedOrder, `${family} exact eight-request success order`);
    equal([success.records.length, success.value.budget.total, success.value.budget.familyRequestCounts], [16, 16, [8, 8]],
      "exact total and per-family request counts");
    const f1 = success.records.filter((row) => row.family === "F1");
    equal(f1[2].params, [runner.FIXED_SCOPE.candidate, "0x100"], "candidate code fixed pin params");
    equal(f1[3].params, [runner.FIXED_SCOPE.candidate, "0x100"], "candidate balance fixed pin params");
    equal(f1[4].params, [runner.FIXED_SCOPE.sender, "0x100"], "sender code fixed pin params");
    equal(f1[5].params, [{ from: runner.FIXED_SCOPE.sender, to: runner.FIXED_SCOPE.candidate, value: "0x0",
      data: runner.FIXED_SCOPE.calldata }, "0x100"], "call exact params");
    equal(f1[6].params, f1[5].params, "estimate uses exact same call and pin");
    equal(f1[7].params, ["0x100", false], "terminal exact-number params");
    equal(runner.sanitizeOutput(JSON.parse(fs.readFileSync(success.outputPath, "utf8"))).status,
      "POSITIVE_CONSERVATIVE_NET_DIAGNOSTIC_ONLY", "positive persisted output sanitized");

    const nonpositive = await mockedCapture("nonpositive", { balance: 30000000000000n });
    equal([nonpositive.value.status, nonpositive.value.reasonCode, nonpositive.value.facts.estimateA,
      nonpositive.value.facts.terminalRecheckMatched], ["INCOMPLETE_FAIL_CLOSED", "NONPOSITIVE_CONSERVATIVE_NET", "30000", true],
    "end-to-end nonpositive economics retains furthest evidence");
    equal(nonpositive.value.economic, { openingBalanceWei: "30000000000000", estimateA: "30000", estimateB: "40000",
      selectedMaxEstimate: "40000", fixedPinBaseFeeWei: "1000000000", gasUsed: "48000",
      stressedBaseFeeWei: "1125000000", priorityCompetitionWei: "2000000000",
      conservativeNetWei: "-120000000000000", conservativeNetPositive: false },
    "end-to-end nonpositive output persists every sanitized economic field");
    const fundingFailure = await mockedCapture("funding-failure", { fundingFailure: true });
    equal([fundingFailure.value.status, fundingFailure.value.reasonCode,
      fundingFailure.value.facts.senderBalanceDiagnosticPerformed, fundingFailure.value.facts.senderBalanceDiagnosticComplete],
    ["INCOMPLETE_FAIL_CLOSED", "ESTIMATE_FAILED", true, true], "funding diagnostic status persists and remains fail closed");
    equal(fundingFailure.records.map((row) => `${row.family}:${row.method}`), [
      "F1:eth_chainId", "F1:eth_getBlockByNumber", "F2:eth_chainId", "F2:eth_getBlockByNumber",
      "F1:eth_getCode", "F1:eth_getBalance", "F2:eth_getCode", "F2:eth_getBalance",
      "F1:eth_getCode", "F2:eth_getCode", "F1:eth_call", "F2:eth_call",
      "F1:eth_estimateGas", "F2:eth_estimateGas", "F1:eth_getBalance"
    ], "funding diagnostic exact method sequence has no retry or terminal read");
    equal(fundingFailure.records[14].params, [runner.FIXED_SCOPE.sender, "0x100"],
      "funding diagnostic is the conditional fixed-pin sender balance query");
    const senderFailure = await mockedCapture("sender-failure", { senderCode: "0x12" });
    equal([senderFailure.value.reasonCode, senderFailure.value.facts.senderCodeAgreement, senderFailure.records.length],
      ["SENDER_CODE_NONEMPTY_OR_MISMATCH", false, 10], "mandatory sender code qualification fails before call");
    const terminalFailure = await mockedCapture("terminal-failure", { terminalMismatch: true });
    equal([terminalFailure.value.reasonCode, terminalFailure.value.facts.terminalRecheckMatched],
      ["TERMINAL_PIN_MISMATCH", false], "terminal mismatch fail path retains evidence");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  process.stdout.write(`${JSON.stringify({ status: "PASS", checks, fixtureClasses: FIXTURE.fixtureClasses.length,
    networkReads: 0, inventoryReads: 0, captureExecuted: false, approvalCreated: false }, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
