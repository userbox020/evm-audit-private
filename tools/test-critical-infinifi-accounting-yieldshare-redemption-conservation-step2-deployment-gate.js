#!/usr/bin/env node
"use strict";

const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const runner = require("./critical-infinifi-accounting-yieldshare-redemption-conservation-step2-deployment-gate-runner.js");
const ROOT = path.resolve(__dirname, "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", `${runner.STEM}-fixtures.json`), "utf8"));
const HASH_A = `0x${"aa".repeat(32)}`, HASH_B = `0x${"bb".repeat(32)}`;
let checks = 0;
const equal = (a, b, m) => { checks += 1; assert.deepStrictEqual(a, b, `check ${checks}: ${m}`); };
const check = (v, m) => { checks += 1; assert.ok(v, `check ${checks}: ${m}`); };
const throws = (fn, code, m) => { checks += 1; assert.throws(fn, new RegExp(code, "u"), `check ${checks}: ${m}`); };
const rejects = async (fn, code, m) => { checks += 1; await assert.rejects(fn, new RegExp(code, "u"), `check ${checks}: ${m}`); };
function response(body, status = 200) { let done = false, cancelled = false; return { status, redirected: false, headers: { get: () => null },
  body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: Buffer.from(body) }),
    cancel: async () => { cancelled = true; } }) }, cancelled: () => cancelled }; }
const envelope = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });
const endpoints = () => [1, 2, 3, 4].map((n) => ({ url: `mock://candidate-${n}`, family: `C${n}` }));
const context = (fetchImpl, caps = runner.CAPS, now) => ({ caps, budget: new runner.Budget(caps, now), nextId: 0, fetchImpl });
function qualificationFetch(sequence) { return async (url, request) => { const body = JSON.parse(request.body), mode = sequence[Number(url.slice(-1)) - 1];
  if (mode === "transport") throw new Error("offline"); if (mode === "http") return response("", 500); if (mode === "malformed") return response("bad");
  if (mode === "rpc") return response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -1, message: "offline" } }));
  return response(envelope(body.id, mode === "non1" ? "0x2" : "0x1")); }; }
function approval(now) { const c = runner.commitments(), expected = { approvalId: "infinifi-step2-0123456789abcdef0123456789abcdef",
  runnerSha256: HASH_A, packageManifestSha256: HASH_A, packageAggregateSha256: HASH_A, evidenceBinding: HASH_A,
  proposalCommitment: HASH_A, reviewMaterialManifestSha256: HASH_A, ...c };
  const payload = { approvalId: expected.approvalId, findingId: runner.FINDING_ID, targetChainId: 1,
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), authorizedCaptureCount: 1,
    fixedApprovalPath: runner.FIXED_APPROVAL_REL, fixedOutputPath: runner.FIXED_OUTPUT_REL, globalConsumptionLedger: runner.LEDGER_REL,
    endpointInventoryReadAuthorized: true, transactionsAuthorized: false, traceAuthorized: false, forkAuthorized: false,
    runnerSha256: HASH_A, packageManifestSha256: HASH_A, packageAggregateSha256: HASH_A, evidenceBinding: HASH_A,
    proposalCommitment: HASH_A, reviewMaterialManifestSha256: HASH_A, ...c, allowedMethods: [...runner.ALLOWED_METHODS].sort(),
    approvalAuthenticityAssumption: "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM" };
  return { expected, envelope: { schemaVersion: 2, state: "AUTHORIZED", approvalPayload: payload,
    approvalCommitment: runner.bytes32Commitment(payload) } }; }

async function main() {
  equal(FIXTURE.fixtureClasses.length, 32, "fixture count");
  const preflight = runner.dryPreflight(); equal(preflight.status, "REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED", "status");
  equal(preflight.methods.allowed, ["eth_call", "eth_chainId", "eth_getBlockByNumber"], "allowlist");
  equal([preflight.caps.maxCandidates, preflight.caps.maxRequestsPerCandidate, preflight.caps.maxTotalRequests, preflight.caps.retriesPerRequest],
    [4, 4, 10, 0], "caps"); equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "zero effects");
  const watched = [runner.FIXED_APPROVAL_REL, runner.LEDGER_REL, runner.FIXED_OUTPUT_REL].map((p) => path.join(ROOT, ...p.split("/"))), before = watched.map(fs.existsSync);
  const child = cp.spawnSync(process.execPath, [path.join(__dirname, `${runner.STEM}-runner.js`), "--check-only"], { cwd: ROOT, encoding: "utf8", env: {} });
  equal([child.status, child.stderr, watched.map(fs.existsSync)], [0, "", before], "check-only side effects"); equal(JSON.parse(child.stdout), preflight, "deterministic preflight");
  check(runner.validateSourceBindings(), "source and configuration bindings");

  let ctx = context(qualificationFetch(["transport", "chain1", "chain1"])), q = await runner.qualify(endpoints(), ctx);
  equal([q.ok, q.counters.candidatesExamined, q.counters.queryFailures, q.rows.length], [true, 3, 1, 2], "transport skip");
  ctx = context(qualificationFetch(["non1", "malformed", "chain1", "chain1"])); q = await runner.qualify(endpoints(), ctx);
  equal([q.ok, q.counters.observedNonTarget, q.counters.malformed, q.rows.length], [true, 1, 1, 2], "non1 malformed skip");
  ctx = context(qualificationFetch(["http", "rpc", "chain1", "chain1"])); q = await runner.qualify(endpoints(), ctx);
  equal([q.ok, q.counters.queryFailures, q.rows.length], [true, 2, 2], "HTTP RPC skip");
  ctx = context(qualificationFetch(["chain1", "non1", "transport", "malformed"])); q = await runner.qualify(endpoints(), ctx);
  equal([q.ok, q.reason, q.rows.length], [false, "QUALIFICATION_ONLY_ONE_ELIGIBLE_FAMILY", 1], "one eligible");
  ctx = context(qualificationFetch(["non1", "non1", "non1", "non1"])); q = await runner.qualify(endpoints(), ctx);
  equal([q.reason, q.counters.candidatesExamined, ctx.budget.summary().chainIdRequestCount], ["NON_TARGET_CHAIN_CANDIDATES_EXHAUSTED", 4, 4], "exhaustion");

  const total = new runner.Budget(); for (let i = 0; i < 10; i++) total.consume(`C${Math.floor(i / 4) + 1}`, "eth_chainId");
  equal(total.summary().total, 10, "ten accepted"); throws(() => total.consume("C4", "eth_chainId"), "TOTAL_REQUESTS", "eleventh rejected");
  const raised = { ...runner.CAPS, maxTotalRequests: 100 }, per = new runner.Budget(raised); for (let i = 0; i < 4; i++) per.consume("C1", "eth_call");
  throws(() => per.consume("C1", "eth_call"), "CANDIDATE_REQUESTS", "fifth candidate request rejected");
  let clock = 0; const timed = new runner.Budget({ ...runner.CAPS, maxElapsedMs: 1 }, () => { clock += 2; return clock; });
  throws(() => timed.checkTime(), "TIME", "elapsed cap"); throws(() => new runner.Budget().consume("C1", "eth_getBalance"), "METHOD_FORBIDDEN", "method forbidden");

  const malformed = runner.parseEnvelope("bad", 1); equal(malformed.error, "MALFORMED_JSON", "malformed envelope");
  await rejects(() => runner.readStreamed({ arrayBuffer: async () => Buffer.alloc(1) }, context(async () => {}), new AbortController()),
    "STREAMING_BODY_REQUIRED", "stream required");
  const small = { ...runner.CAPS, maxResponseBytes: 2 }, oversized = response("123");
  await rejects(() => runner.readStreamed(oversized, context(async () => {}, small), new AbortController()), "SINGLE_RESPONSE_BYTES", "body cap");
  const aggregate = { ...runner.CAPS, maxAggregateResponseBytes: 2 };
  await rejects(() => runner.readStreamed(response("123"), context(async () => {}, aggregate), new AbortController()), "AGGREGATE_RESPONSE_BYTES", "aggregate cap");

  const now = Date.parse("2026-08-01T12:00:00Z"), valid = approval(now);
  equal(runner.validateApprovalEnvelope(valid.envelope, valid.expected, now, false).approvalId, valid.expected.approvalId, "approval valid");
  throws(() => runner.validateApprovalEnvelope(valid.envelope, valid.expected, now, true), "ALREADY_CONSUMED", "replay");
  const expired = JSON.parse(JSON.stringify(valid.envelope)); expired.approvalPayload.expiresAt = new Date(now - 1).toISOString(); expired.approvalCommitment = runner.bytes32Commitment(expired.approvalPayload);
  throws(() => runner.validateApprovalEnvelope(expired, valid.expected, now, false), "WINDOW_INVALID", "expiry");
  const pathChanged = JSON.parse(JSON.stringify(valid.envelope)); pathChanged.approvalPayload.fixedOutputPath += ".x"; pathChanged.approvalCommitment = runner.bytes32Commitment(pathChanged.approvalPayload);
  throws(() => runner.validateApprovalEnvelope(pathChanged, valid.expected, now, false), "BINDING_INVALID", "path binding");
  const hashChanged = JSON.parse(JSON.stringify(valid.envelope)); hashChanged.approvalPayload.configCommitment = HASH_A; hashChanged.approvalCommitment = runner.bytes32Commitment(hashChanged.approvalPayload);
  throws(() => runner.validateApprovalEnvelope(hashChanged, valid.expected, now, false), "BINDING_INVALID", "hash binding");

  throws(() => runner.sanitizeOutput({ url: "https://invalid" }), "ADDRESS_OR_URL_LEAK", "URL leak");
  throws(() => runner.sanitizeOutput({ value: "0x1111111111111111111111111111111111111111" }), "ADDRESS_OR_URL_LEAK", "address leak");
  throws(() => runner.sanitizeOutput({ calldata: "0x12" }), "FORBIDDEN_KEY", "calldata key leak");

  const parent = path.join(os.tmpdir(), "opencode"); check(fs.existsSync(parent), "temp parent"); const dir = fs.mkdtempSync(path.join(parent, "infinifi-step2-"));
  try {
    const once = { ledgerPath: path.join(dir, "wx.json"), approvalId: valid.expected.approvalId, approvalCommitment: valid.envelope.approvalCommitment };
    runner.consumeApproval(once); throws(() => runner.consumeApproval(once), "EEXIST", "wx concurrency");
    async function full(name, options = {}) { const pin = { number: "0x100", hash: HASH_A, timestamp: "0x200", baseFeePerGas: "0x3b9aca00" }, records = [];
      const sequence = options.sequence || ["malformed", "non1", "chain1", "chain1"];
      const fetchImpl = async (url, request) => { const body = JSON.parse(request.body), candidate = Number(url.slice(-1)), mode = sequence[candidate - 1];
        records.push({ candidate, method: body.method, params: body.params });
        if (body.method === "eth_chainId") { if (mode === "transport") throw new Error("offline"); if (mode === "malformed") return response("bad");
          return response(envelope(body.id, mode === "non1" ? "0x2" : "0x1")); }
        if (body.method === "eth_getBlockByNumber") { const terminal = body.params[0] !== "finalized";
          const hash = options.pinMismatch && !terminal && candidate === 4 ? HASH_B : options.terminalMismatch && terminal && candidate === 4 ? HASH_B : HASH_A;
          return response(envelope(body.id, { ...pin, hash })); }
        if (body.method === "eth_call") { if (options.malformedBalance && candidate === 3) return response(envelope(body.id, "0x12"));
          const amount = options.balanceMismatch && candidate === 4 ? BigInt(options.balance || 0) + 1n : BigInt(options.balance || 0);
          return response(envelope(body.id, `0x${amount.toString(16).padStart(64, "0")}`)); }
        throw new Error("unexpected"); };
      const ledgerPath = path.join(dir, `${name}-ledger.json`), outputPath = path.join(dir, `${name}-output.json`);
      const value = await runner.runCapture({ capture: true }, { validateApproval: () => ({ ledgerPath, outputPath,
        approvalId: valid.expected.approvalId, approvalCommitment: valid.envelope.approvalCommitment }), loadInventory: () => endpoints(), fetchImpl });
      return { value, records, outputPath }; }

    const zero = await full("zero"); equal([zero.value.status, zero.value.facts.balanceRaw, zero.value.facts.balanceDecimals,
      zero.value.facts.balanceIsZero, zero.value.facts.balancePositive, zero.value.facts.residueClassification], ["CURRENT_ZERO_RESIDUE_NO_CURRENT_CAPTURE", "0", 6, true, false,
      "CURRENT-ZERO-RESIDUE/NO-CURRENT-CAPTURE"], "zero classification");
    equal([zero.value.budget.total, zero.value.budget.chainIdRequestCount, zero.value.budget.selectedFamilyRequestCounts,
      zero.value.budget.rejectedCandidateRequestCounts], [10, 4, [4, 4], [1, 1]], "worst-case ten accounting");
    equal(zero.records.map((r) => `${r.candidate}:${r.method}`), ["1:eth_chainId", "2:eth_chainId", "3:eth_chainId", "4:eth_chainId",
      "3:eth_getBlockByNumber", "4:eth_getBlockByNumber", "3:eth_call", "4:eth_call", "3:eth_getBlockByNumber", "4:eth_getBlockByNumber"], "exact order");
    equal(zero.records[6].params, [{ to: runner.FIXED_SCOPE.usdc, data: runner.FIXED_SCOPE.balanceCalldata }, "0x100"], "exact balance call");
    equal(zero.value.operationalGates, { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, "zero gates closed");
    const nonzero = await full("nonzero", { balance: 1234567n }); equal([nonzero.value.status, nonzero.value.facts.balanceRaw,
      nonzero.value.facts.balanceDecimals, nonzero.value.facts.balanceIsZero, nonzero.value.facts.balancePositive, nonzero.value.facts.residueClassification],
    ["NONZERO_FIXED_PIN_RESIDUE_CONFIG_REVIEW_REQUIRED", "1234567", 6, false, true, "NONZERO-FIXED-PIN-RESIDUE/CONFIG-REVIEW-REQUIRED"], "nonzero classification");
    equal(nonzero.value.operationalGates, { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, "nonzero gates closed");
    equal((await full("pin-mismatch", { pinMismatch: true })).value.reasonCode, "FINALIZED_PIN_MISMATCH", "pin mismatch");
    equal((await full("balance-malformed", { malformedBalance: true })).value.reasonCode, "BALANCE_RESULT_MALFORMED", "malformed balance");
    equal((await full("balance-mismatch", { balance: 5n, balanceMismatch: true })).value.reasonCode, "BALANCE_MISMATCH", "balance mismatch");
    equal((await full("terminal-mismatch", { terminalMismatch: true })).value.reasonCode, "TERMINAL_PIN_MISMATCH", "terminal mismatch");
    runner.sanitizeOutput(JSON.parse(fs.readFileSync(nonzero.outputPath, "utf8"))); check(true, "persisted output sanitized");
    const failureLedger = path.join(dir, "failure-ledger.json"), failureOutput = path.join(dir, "failure-output.json");
    const failed = await runner.runCapture({ capture: true }, { validateApproval: () => ({ ledgerPath: failureLedger, outputPath: failureOutput,
      approvalId: valid.expected.approvalId, approvalCommitment: valid.envelope.approvalCommitment }), loadInventory: () => { throw new Error("offline failure"); } });
    equal([fs.existsSync(failureLedger), fs.existsSync(failureOutput), failed.status, failed.reasonCode], [true, true, "INCOMPLETE_FAIL_CLOSED", "CAPTURE_FAILURE"],
      "post-consumption failure persisted");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  process.stdout.write(`${JSON.stringify({ status: "PASS", checks, fixtureClasses: FIXTURE.fixtureClasses.length, networkReads: 0,
    inventoryReads: 0, captureExecuted: false, approvalCreated: false }, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
