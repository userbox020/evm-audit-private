#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { keccak256, version: ethersVersion } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const STEM = "critical-uniswapx-v2-empty-batch-opening-eth-deployment-economics-step3";
const FINDING_ID = `${STEM}-capture`;
const CHAIN_ID = 1;
const CANDIDATE = "0x00000011f84b9aa48e5f8aa8b9897600006289be";
const SENDER = "0x000000000000000000000000000000000000dead";
const CALLDATA = "0x0d7a16c300000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000";
const EXPECTED_RUNTIME_BYTES = 13003;
const EXPECTED_RUNTIME_HASH = "0x348af5101391c6649d9ac4a623af571d3aed3e2f267fc1fda19a098993e0ea7d";
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const FIXED_OUTPUT_REL = `reports/raw/fast/${STEM}-capture.json`;
const FIXED_APPROVAL_REL = `coordination/decisions/${STEM}-capture-approval.json`;
const LEDGER_REL = `coordination/decisions/${STEM}-capture-consumption-ledger.json`;
const PACKAGE_MANIFEST_REL = `reports/raw/fast/${STEM}-capture-package-manifest.json`;
const EVIDENCE_MANIFEST_REL = `reports/raw/fast/${STEM}-capture-evidence-manifest.json`;
const PROPOSAL_REL = `reports/raw/fast/${STEM}-capture-approval-proposal.json`;
const REVIEW_MANIFEST_REL = `reports/raw/fast/${STEM}-capture-review-material-manifest.json`;
const PREFLIGHT_REL = `reports/raw/fast/${STEM}-capture-preflight.json`;
const REPORT_REL = `reports/${STEM}-capture-preflight.md`;

const ALLOWED_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getBalance", "eth_call", "eth_estimateGas"]);
const FORBIDDEN_METHODS = new Set(["eth_getLogs", "eth_getStorageAt", "debug_traceCall", "trace_call", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "eth_sendTransaction", "eth_sendRawTransaction"]);
const CAPS = Object.freeze({
  chains: 1,
  maxInventoryEntries: 16,
  maxInventoryBytes: 65536,
  maxInventoryLines: 512,
  maxFamilies: 4,
  requiredHostnameDistinctFamilies: 2,
  maxRequestsPerFamily: 8,
  maxTotalRequests: 16,
  retriesPerRequest: 0,
  requestTimeoutMs: 10000,
  maxElapsedMs: 120000,
  maxResponseBytes: 2097152,
  maxAggregateResponseBytes: 16777216,
  maxApprovalWindowMs: 600000,
  maxApprovalIssuedAgeMs: 180000,
  maxApprovalFutureSkewMs: 30000
});
const ECONOMIC_POLICY = Object.freeze({
  minChargedGas: 21830,
  gasBufferNumerator: 120,
  gasBufferDenominator: 100,
  stressedBaseFeeNumerator: 9,
  stressedBaseFeeDenominator: 8,
  minimumPriorityCompetitionWei: "2000000000",
  priorityCompetitionDivisor: 4
});
const TOOLCHAIN = Object.freeze({ nodeVersion: process.version, ethersVersion });
const PACKAGE_ARTIFACTS = Object.freeze([
  `tools/${STEM}-runner.js`,
  `tools/test-${STEM}.js`,
  `tools/validate-${STEM}.js`,
  `tools/fixtures/${STEM}-fixtures.json`,
  EVIDENCE_MANIFEST_REL
]);
const EVIDENCE_PATHS = Object.freeze([
  `reports/${STEM}.md`,
  `reports/raw/fast/${STEM}.json`,
  "coordination/inbox/critical/20260801-critical-uniswapx-v2-empty-batch-opening-eth-step3.json",
  "coordination/handoffs/20260801-critical-uniswapx-v2-empty-batch-opening-eth-step3-handoff.md",
  "reports/critical-uniswapx-v2-full-reactor-conservation-step2.md",
  "reports/raw/fast/critical-uniswapx-v2-full-reactor-conservation-step2.json",
  "sources/uniswapx-v2-full-reactor-conservation-step2/src/reactors/BaseReactor.sol",
  "sources/uniswapx-v2-full-reactor-conservation-step2/src/lib/CurrencyLibrary.sol",
  "sources/uniswapx-v2-full-reactor-conservation-step2/foundry.toml",
  "sources/uniswapx-v2-full-reactor-conservation-step2/remappings.txt",
  "sources/uniswapx-v2-full-reactor-conservation-step2/.gitmodules"
  ,"sources/uniswapx-v2-full-reactor-conservation-step2/src/reactors/V2DutchOrderReactor.sol"
  ,"sources/uniswapx-v2-full-reactor-conservation-step2/script/DeployDutchV2.s.sol"
  ,"tools/package.json"
  ,"tools/package-lock.json"
]);

const rel = (value) => path.join(ROOT, ...value.split("/"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
const bytes32Commitment = (value) => `0x${sha256(Buffer.from(canonicalJson(value), "utf8"))}`;
const COMPARATOR_RECORD = Object.freeze({
  compiledArtifactPresent: false,
  artifactRuntimeTemplateKeccak256: "0x71a1cdf1eada76ece6a89eea962e0c8f3fd359b74a808a07799b878d632d232d",
  runtimeBytes: EXPECTED_RUNTIME_BYTES,
  immutableId: "permit2",
  immutableOffsetsBytes: [218, 6795],
  immutablePatchLengthBytes: 32,
  canonicalEncoding: "left-zero-padded-address-to-32-bytes",
  canonicalEncodingCommitment: bytes32Commitment({ immutableId: "permit2", encoding: "left-zero-padded-address-to-32-bytes" }),
  patchedRuntimeKeccak256: EXPECTED_RUNTIME_HASH
});
const strictHex = (value, bytes = null) => typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/u.test(value) &&
  (bytes === null || value.length === bytes * 2 + 2) ? value.toLowerCase() : null;
function strictQuantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) return null;
  try { return BigInt(value); } catch (_) { return null; }
}
const toQuantity = (value) => `0x${BigInt(value).toString(16)}`;
const ceilDiv = (value, denominator) => (value + denominator - 1n) / denominator;
const ceilMulDiv = (value, numerator, denominator) => ceilDiv(value * numerator, denominator);

function commitments() {
  return Object.freeze({
    candidateCommitment: bytes32Commitment({ role: "candidate", value: CANDIDATE }),
    senderCommitment: bytes32Commitment({ role: "simulation-sender", value: SENDER }),
    calldataCommitment: bytes32Commitment({ bytes: 68, value: CALLDATA }),
    runtimeCommitment: bytes32Commitment({ bytes: EXPECTED_RUNTIME_BYTES, hash: EXPECTED_RUNTIME_HASH }),
    methodsCommitment: bytes32Commitment([...ALLOWED_METHODS].sort()),
    capsCommitment: bytes32Commitment(CAPS),
    economicPolicyCommitment: bytes32Commitment(ECONOMIC_POLICY)
  });
}

function assertExactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(code);
  }
}

class Budget {
  constructor(caps = CAPS, now = () => Date.now()) {
    this.caps = caps;
    this.now = now;
    this.startedAt = now();
    this.total = 0;
    this.perFamily = {};
    this.responseBytes = 0;
    this.exhausted = null;
  }
  fail(reason) { this.exhausted = reason; throw new Error(`BUDGET_EXHAUSTED_${reason}`); }
  checkTime() { if (this.now() - this.startedAt > this.caps.maxElapsedMs) this.fail("TIME"); }
  consume(family, method) {
    this.checkTime();
    if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) throw new Error("METHOD_FORBIDDEN");
    this.total += 1;
    this.perFamily[family] = (this.perFamily[family] || 0) + 1;
    if (this.total > this.caps.maxTotalRequests) this.fail("TOTAL_REQUESTS");
    if (this.perFamily[family] > this.caps.maxRequestsPerFamily) this.fail("FAMILY_REQUESTS");
  }
  consumeBytes(bytes) {
    this.responseBytes += bytes;
    if (this.responseBytes > this.caps.maxAggregateResponseBytes) this.fail("AGGREGATE_RESPONSE_BYTES");
  }
  summary() {
    const elapsedWithinCap = this.now() - this.startedAt <= this.caps.maxElapsedMs;
    return { total: this.total, familyRequestCounts: Object.keys(this.perFamily).sort().map((family) => this.perFamily[family]),
      responseBytes: this.responseBytes, exhausted: this.exhausted, elapsedWithinCap,
      allWithinCaps: this.exhausted === null && elapsedWithinCap };
  }
}

function parseEnvelope(body, expectedId) {
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { return { ok: false, error: "MALFORMED_JSON", result: null }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.jsonrpc !== "2.0" || parsed.id !== expectedId) {
    return { ok: false, error: "ENVELOPE_MISMATCH", result: null };
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "error")) {
    const message = parsed.error && typeof parsed.error.message === "string" ? parsed.error.message : "";
    return { ok: false, error: /insufficient funds|funds for gas/iu.test(message) ? "ESTIMATE_FUNDING_CHECK" : "RPC_ERROR", result: null };
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "result")) return { ok: false, error: "MISSING_RESULT", result: null };
  return { ok: true, error: null, result: parsed.result };
}

async function readStreamed(response, context, controller) {
  if (!response.body || typeof response.body.getReader !== "function") { controller.abort(); throw new Error("STREAMING_BODY_REQUIRED"); }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    context.budget.checkTime();
    const row = await reader.read();
    if (row.done) break;
    const chunk = Buffer.from(row.value);
    total += chunk.length;
    if (total > context.caps.maxResponseBytes) { controller.abort(); await reader.cancel(); context.budget.fail("SINGLE_RESPONSE_BYTES"); }
    try { context.budget.consumeBytes(chunk.length); } catch (error) { controller.abort(); await reader.cancel(); throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function rpcRequest(endpoint, method, params, context, fetchImpl = context.fetchImpl || fetch) {
  if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) return { ok: false, error: "METHOD_FORBIDDEN", result: null };
  context.budget.consume(endpoint.family, method);
  const requestId = ++context.nextId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.caps.requestTimeoutMs);
  try {
    const response = await fetchImpl(endpoint.url, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), signal: controller.signal });
    if (response.redirected || response.status < 200 || response.status >= 300) {
      controller.abort();
      if (response.body && typeof response.body.getReader === "function") {
        try { await response.body.getReader().cancel(); } catch (_) {}
      }
      return { ok: false, error: "HTTP_FAILURE", result: null };
    }
    const declared = response.headers && response.headers.get ? Number(response.headers.get("content-length")) : 0;
    if (declared > context.caps.maxResponseBytes) { controller.abort(); context.budget.fail("SINGLE_RESPONSE_BYTES"); }
    return parseEnvelope(await readStreamed(response, context, controller), requestId);
  } catch (error) {
    if (/^BUDGET_EXHAUSTED_|STREAMING_BODY_REQUIRED/u.test(String(error.message || error))) throw error;
    return { ok: false, error: "TRANSPORT_FAILURE", result: null };
  } finally { clearTimeout(timer); }
}

function parseHeader(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const number = strictQuantity(value.number); const hash = strictHex(value.hash, 32);
  const timestamp = strictQuantity(value.timestamp); const baseFee = strictQuantity(value.baseFeePerGas);
  return number === null || !hash || timestamp === null || baseFee === null || baseFee <= 0n ? null : { number, hash, timestamp, baseFee };
}
const headersEqual = (a, b) => Boolean(a && b && a.number === b.number && a.hash === b.hash && a.timestamp === b.timestamp && a.baseFee === b.baseFee);

function loadInventoryAuthorized(context, inventoryPath = INVENTORY_PATH) {
  context.budget.checkTime();
  const stat = fs.statSync(inventoryPath);
  if (stat.size > context.caps.maxInventoryBytes) throw new Error("INVENTORY_BYTES_EXCEEDED");
  const content = fs.readFileSync(inventoryPath, "utf8");
  const lines = content.split(/\r?\n/u);
  if (lines.length > context.caps.maxInventoryLines) throw new Error("INVENTORY_LINES_EXCEEDED");
  const endpoints = []; const hosts = new Set();
  let inventoryEntries = 0;
  for (const line of lines) {
    context.budget.checkTime();
    const match = line.match(/https:\/\/[^\s'"<>\[\]]+/u); if (!match) continue;
    let parsed; try { parsed = new URL(match[0].replace(/[)\]]+$/u, "")); } catch (_) { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || /testnet|sepolia|hoodi|gnosis|chiado/iu.test(parsed.href)) continue;
    inventoryEntries += 1;
    if (inventoryEntries > context.caps.maxInventoryEntries) throw new Error("INVENTORY_ENTRIES_EXCEEDED");
    const host = parsed.hostname.toLowerCase(); if (hosts.has(host)) continue;
    hosts.add(host); endpoints.push({ url: parsed.href, family: `F${hosts.size}` });
    if (endpoints.length >= context.caps.maxInventoryEntries || hosts.size >= context.caps.maxFamilies) break;
  }
  return endpoints;
}

function calculateEconomics(balance, estimateA, estimateB, baseFee) {
  const minGas = BigInt(ECONOMIC_POLICY.minChargedGas);
  const maxEstimate = [BigInt(estimateA), BigInt(estimateB), minGas].reduce((a, b) => a > b ? a : b);
  const gasUsed = ceilMulDiv(maxEstimate, BigInt(ECONOMIC_POLICY.gasBufferNumerator), BigInt(ECONOMIC_POLICY.gasBufferDenominator));
  const stressedBaseFee = ceilMulDiv(BigInt(baseFee), BigInt(ECONOMIC_POLICY.stressedBaseFeeNumerator),
    BigInt(ECONOMIC_POLICY.stressedBaseFeeDenominator));
  const priorityQuarter = ceilDiv(stressedBaseFee, BigInt(ECONOMIC_POLICY.priorityCompetitionDivisor));
  const minimumPriority = BigInt(ECONOMIC_POLICY.minimumPriorityCompetitionWei);
  const priorityCompetition = priorityQuarter > minimumPriority ? priorityQuarter : minimumPriority;
  const cost = gasUsed * (stressedBaseFee + priorityCompetition);
  return { gasUsed, stressedBaseFee, priorityCompetition, conservativeNetWei: BigInt(balance) - cost,
    positive: BigInt(balance) - cost > 0n };
}

function evaluateFixedState(states, baseFee, expectation = { bytes: EXPECTED_RUNTIME_BYTES, hash: EXPECTED_RUNTIME_HASH }) {
  const runtimeOk = Array.isArray(states) && states.length === 2 && states.every((s) => s.code && s.code !== "0x" &&
    (s.code.length - 2) / 2 === expectation.bytes && keccak256(s.code) === expectation.hash) && states[0].code === states[1].code;
  if (!runtimeOk) return { ok: false, reason: "RUNTIME_EMPTY_OR_MISMATCH", runtimeAgreement: false, balanceAgreement: false };
  return { runtimeAgreement: true, ...evaluateBalance(states[0].balance, states[1].balance, baseFee) };
}

function evaluateBalance(left, right, baseFee) {
  if (left === null || right === null || left !== right) return { ok: false, reason: "BALANCE_MISMATCH", balanceAgreement: false };
  if (left === 0n) return { ok: false, reason: "ZERO_BALANCE", balanceAgreement: true };
  if (left <= BigInt(ECONOMIC_POLICY.minChargedGas) * BigInt(baseFee)) return { ok: false, reason: "BALANCE_AT_OR_BELOW_HARD_FLOOR", balanceAgreement: true };
  return { ok: true, reason: null, balanceAgreement: true, balance: left };
}

function evaluateCallResults(results) {
  return Array.isArray(results) && results.length === 2 && results.every((row) => row && row.ok === true && row.result === "0x")
    ? { ok: true, reason: null }
    : { ok: false, reason: "CALL_REVERT_OR_NONEMPTY" };
}

function evaluateEstimateResults(results) {
  if (!Array.isArray(results) || results.length !== 2) return { ok: false, reason: "ESTIMATE_FAILED", fundingQualificationRequired: false, estimates: [] };
  const estimates = results.map((row) => row && row.ok ? strictQuantity(row.result) : null);
  return estimates.every((value) => value !== null)
    ? { ok: true, reason: null, fundingQualificationRequired: false, estimates }
    : { ok: false, reason: "ESTIMATE_FAILED", fundingQualificationRequired: results.some((row) => row && row.error === "ESTIMATE_FUNDING_CHECK"), estimates: [] };
}

function baseFacts() {
  return { chainId: CHAIN_ID, hostnameDiversityFamilyCount: 0, hostnameDiversityThresholdMet: false,
    backendIndependenceProven: false, candidateRole: "fixed-v2-reactor-candidate", senderRole: "fixed-simulation-sender",
    commitments: commitments(), fixedPinAgreement: false, runtimeAgreement: false, balanceAgreement: false,
    senderCodeAgreement: false, callAgreement: false, estimateBothSucceeded: false, terminalPinAgreement: false,
    fixedPinNumber: null, fixedPinHash: null, fixedPinTimestamp: null, fixedPinBaseFeeWei: null,
    estimateA: null, estimateB: null, selectedMaxEstimate: null,
    senderBalanceDiagnosticPerformed: false, senderBalanceDiagnosticComplete: null,
    terminalRecheckMatched: false, toolchain: TOOLCHAIN };
}

function failClosed(reasonCode, budget, facts = baseFacts()) {
  return { schemaVersion: 1, findingId: FINDING_ID, status: "INCOMPLETE_FAIL_CLOSED", reasonCode,
    liveCaptureExecuted: true, resultPromoted: false, facts,
    economic: { conservativeNetPositive: null },
    operationalGates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, budget };
}

function economicEvidence(facts, economics) {
  return { openingBalanceWei: facts.openingBalanceWei, estimateA: facts.estimateA, estimateB: facts.estimateB,
    selectedMaxEstimate: facts.selectedMaxEstimate, fixedPinBaseFeeWei: facts.fixedPinBaseFeeWei,
    gasUsed: economics.gasUsed.toString(), stressedBaseFeeWei: economics.stressedBaseFee.toString(),
    priorityCompetitionWei: economics.priorityCompetition.toString(), conservativeNetWei: economics.conservativeNetWei.toString(),
    conservativeNetPositive: economics.positive };
}

function nonpositiveResult(facts, economics, budget) {
  if (!budget || budget.allWithinCaps !== true || economics.positive !== false) return failClosed("NONPOSITIVE_EVIDENCE_INCOMPLETE", budget, facts);
  return { schemaVersion: 1, findingId: FINDING_ID, status: "INCOMPLETE_FAIL_CLOSED", reasonCode: "NONPOSITIVE_CONSERVATIVE_NET",
    liveCaptureExecuted: true, resultPromoted: false, facts, economic: economicEvidence(facts, economics),
    operationalGates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, budget };
}

function positiveResult(facts, economics, budget) {
  if (!budget || budget.allWithinCaps !== true || economics.positive !== true) return failClosed("NONPOSITIVE_OR_BUDGET_INCOMPLETE", budget, facts);
  return { schemaVersion: 1, findingId: FINDING_ID, status: "POSITIVE_CONSERVATIVE_NET_DIAGNOSTIC_ONLY", reasonCode: null,
    liveCaptureExecuted: true, resultPromoted: false, facts, economic: economicEvidence(facts, economics),
    operationalGates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, budget };
}

function sanitizeOutput(value) {
  const text = canonicalJson(value);
  if (/(?:https?|wss?):\/\//iu.test(text) || /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/u.test(text)) throw new Error("OUTPUT_ADDRESS_OR_URL_LEAK");
  const forbidden = /^(?:hostname|providerIdentity|providerHash|endpointHash|rawResponse|transactionHash|txHash|calldata|address|sender|from|to)$/iu;
  const stack = [value];
  while (stack.length) { const current = stack.pop(); if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) { if (forbidden.test(key)) throw new Error("OUTPUT_FORBIDDEN_KEY");
      if (child && typeof child === "object") stack.push(child); } }
  return value;
}

function dryPreflight() {
  return { schemaVersion: 1, findingId: FINDING_ID, status: "REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED",
    chain: { chainId: 1, chainCount: 1 },
    authorization: { fixedApprovalPath: FIXED_APPROVAL_REL, fixedOutputPath: FIXED_OUTPUT_REL, globalConsumptionLedger: LEDGER_REL,
      captureFlagRequired: "--capture-once", singleUseFreshApprovalRequired: true,
      approvalAuthenticityAssumption: "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM", authorized: false, captureExecuted: false },
    scope: { candidateRole: "fixed-v2-reactor-candidate", senderRole: "fixed-simulation-sender", calldataBytes: 68,
      expectedRuntimeBytes: EXPECTED_RUNTIME_BYTES, commitments: commitments() },
    providerPolicy: { requiredHostnameDistinctFamilies: 2, backendIndependenceProven: false },
    methods: { allowed: [...ALLOWED_METHODS].sort(), forbidden: [...FORBIDDEN_METHODS].sort() }, caps: CAPS,
    economicPolicy: ECONOMIC_POLICY,
    toolchain: TOOLCHAIN,
    gates: { conservativeNetPositive: null, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    networkReads: 0, inventoryReads: 0, writes: 0 };
}

function parseArgs(argv) {
  const args = { capture: false, checkOnly: false, approvalFile: null };
  for (let i = 2; i < argv.length; i++) { const value = argv[i];
    if (value === "--capture-once") args.capture = true;
    else if (value === "--check-only" || value === "--preflight") args.checkOnly = true;
    else if (value === "--approval-file") args.approvalFile = argv[++i] || null;
    else throw new Error("UNKNOWN_ARGUMENT"); }
  if (args.capture && args.checkOnly) throw new Error("MODE_CONFLICT");
  if (!args.capture) args.checkOnly = true;
  return args;
}

function evidenceRecords() { return EVIDENCE_PATHS.map((artifactPath) => { const bytes = fs.readFileSync(rel(artifactPath));
  return { path: artifactPath, bytes: bytes.length, sha256: sha256(bytes) }; }); }
function validateEvidenceManifest(manifest) {
  assertExactKeys(manifest, ["schemaVersion", "findingId", "status", "algorithm", "artifactCount", "aggregateSha256", "artifacts", "evidenceBinding", "comparatorRecord", "comparatorCommitment", "toolchain"], "EVIDENCE_SCHEMA");
  const records = evidenceRecords(); const aggregate = sha256(Buffer.from(records.map((row) => `${row.path}:${row.sha256}`).sort().join("\n")));
  if (manifest.schemaVersion !== 1 || manifest.findingId !== FINDING_ID || manifest.status !== "LOCAL_EVIDENCE_BOUND" ||
    manifest.algorithm !== "sha256" || manifest.artifactCount !== records.length || canonicalJson(manifest.artifacts) !== canonicalJson(records) ||
    manifest.aggregateSha256 !== aggregate || manifest.evidenceBinding !== bytes32Commitment(records) ||
    canonicalJson(manifest.comparatorRecord) !== canonicalJson(COMPARATOR_RECORD) ||
    manifest.comparatorCommitment !== bytes32Commitment(COMPARATOR_RECORD) || canonicalJson(manifest.toolchain) !== canonicalJson(TOOLCHAIN)) throw new Error("EVIDENCE_MISMATCH");
  return true;
}
function validateArtifactManifest(manifest, expectedPaths, code) {
  assertExactKeys(manifest, ["schemaVersion", "findingId", "status", "algorithm", "artifactCount", "aggregateSha256", "artifacts"], `${code}_SCHEMA`);
  if (!Array.isArray(manifest.artifacts) || canonicalJson(manifest.artifacts.map((r) => r.path).sort()) !== canonicalJson([...expectedPaths].sort())) throw new Error(`${code}_PATHS`);
  for (const row of manifest.artifacts) { assertExactKeys(row, ["path", "bytes", "sha256"], `${code}_ROW`); const bytes = fs.readFileSync(rel(row.path));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) throw new Error(`${code}_ARTIFACT`); }
  const aggregate = sha256(Buffer.from(manifest.artifacts.map((r) => `${r.path}:${r.sha256}`).sort().join("\n")));
  if (manifest.schemaVersion !== 1 || manifest.findingId !== FINDING_ID || manifest.status !== "REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED" || manifest.algorithm !== "sha256" ||
    manifest.artifactCount !== expectedPaths.length || manifest.aggregateSha256 !== aggregate) throw new Error(`${code}_MISMATCH`);
  return true;
}

function validateProposal(proposal) {
  assertExactKeys(proposal, ["schemaVersion", "state", "authorization", "captureExecuted", "proposalPayload", "proposalCommitment",
    "reviewerIssuedApprovalRequirements", "networkReads", "inventoryReads", "approvalCreated"], "PROPOSAL_SCHEMA");
  assertExactKeys(proposal.proposalPayload, ["requestedApprovalId", "findingId", "chainId", "authorizedCaptureCount", "fixedApprovalPath",
    "fixedOutputPath", "globalConsumptionLedger", "runnerSha256", "packageManifestSha256", "packageAggregateSha256", "evidenceBinding",
    "candidateCommitment", "senderCommitment", "calldataCommitment", "runtimeCommitment", "methodsCommitment", "capsCommitment",
    "economicPolicyCommitment", "allowedMethods", "approvalAuthenticityAssumption"], "PROPOSAL_PAYLOAD_SCHEMA");
  assertExactKeys(proposal.reviewerIssuedApprovalRequirements, ["schemaVersion", "state", "requestedApprovalId", "issuedAt", "expiresAt",
    "approvalCommitment", "reviewMaterialManifestSha256", "endpointInventoryReadAuthorized", "transactionsAuthorized", "traceAuthorized",
    "forkAuthorized", "independentReviewRequired"], "PROPOSAL_REVIEW_SCHEMA");
  const payload = proposal.proposalPayload;
  if (proposal.schemaVersion !== 1 || proposal.state !== "REVIEW_REQUESTED" || proposal.authorization !== "NOT_AUTHORIZED" ||
    proposal.captureExecuted !== false || proposal.networkReads !== 0 || proposal.inventoryReads !== 0 || proposal.approvalCreated !== false ||
    !/^uxv2-step3-[0-9a-f]{32}$/u.test(payload.requestedApprovalId || "") || payload.findingId !== FINDING_ID || payload.chainId !== 1 ||
    payload.authorizedCaptureCount !== 1 || payload.fixedApprovalPath !== FIXED_APPROVAL_REL || payload.fixedOutputPath !== FIXED_OUTPUT_REL ||
    payload.globalConsumptionLedger !== LEDGER_REL || payload.approvalAuthenticityAssumption !== "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM" ||
    canonicalJson(payload.allowedMethods) !== canonicalJson([...ALLOWED_METHODS].sort()) ||
    proposal.proposalCommitment !== bytes32Commitment(payload)) throw new Error("PROPOSAL_INVALID");
  const review = proposal.reviewerIssuedApprovalRequirements;
  if (review.schemaVersion !== 2 || review.state !== "AUTHORIZED" || review.requestedApprovalId !== payload.requestedApprovalId ||
    review.issuedAt !== null || review.expiresAt !== null || review.approvalCommitment !== null || review.reviewMaterialManifestSha256 !== null ||
    review.endpointInventoryReadAuthorized !== true || review.transactionsAuthorized !== false || review.traceAuthorized !== false ||
    review.forkAuthorized !== false || review.independentReviewRequired !== true) throw new Error("PROPOSAL_REVIEW_VALUES_INVALID");
  return true;
}

function validateApprovalEnvelope(envelope, expected, now = Date.now(), consumed = false) {
  assertExactKeys(envelope, ["schemaVersion", "state", "approvalPayload", "approvalCommitment"], "APPROVAL_SCHEMA");
  const payload = envelope.approvalPayload;
  const keys = ["approvalId", "findingId", "chainId", "issuedAt", "expiresAt", "authorizedCaptureCount", "fixedApprovalPath",
    "fixedOutputPath", "globalConsumptionLedger", "endpointInventoryReadAuthorized", "transactionsAuthorized", "traceAuthorized",
    "forkAuthorized", "runnerSha256", "packageManifestSha256", "packageAggregateSha256", "evidenceBinding", "proposalCommitment",
    "reviewMaterialManifestSha256", "candidateCommitment", "senderCommitment", "calldataCommitment", "runtimeCommitment",
    "methodsCommitment", "capsCommitment", "economicPolicyCommitment", "allowedMethods", "approvalAuthenticityAssumption"];
  assertExactKeys(payload, keys, "APPROVAL_PAYLOAD_SCHEMA");
  if (envelope.schemaVersion !== 2 || envelope.state !== "AUTHORIZED" || !/^uxv2-step3-[0-9a-f]{32}$/u.test(payload.approvalId || "") ||
    envelope.approvalCommitment !== bytes32Commitment(payload)) throw new Error("APPROVAL_INVALID");
  const issued = Date.parse(payload.issuedAt); const expires = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > CAPS.maxApprovalWindowMs ||
    now - issued > CAPS.maxApprovalIssuedAgeMs || issued > now + CAPS.maxApprovalFutureSkewMs || now >= expires) throw new Error("APPROVAL_WINDOW_INVALID");
  const required = { findingId: FINDING_ID, chainId: 1, authorizedCaptureCount: 1, fixedApprovalPath: FIXED_APPROVAL_REL,
    fixedOutputPath: FIXED_OUTPUT_REL, globalConsumptionLedger: LEDGER_REL, endpointInventoryReadAuthorized: true,
    transactionsAuthorized: false, traceAuthorized: false, forkAuthorized: false,
    approvalAuthenticityAssumption: "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM", allowedMethods: [...ALLOWED_METHODS].sort(), ...expected };
  for (const [key, value] of Object.entries(required)) if (canonicalJson(payload[key]) !== canonicalJson(value)) throw new Error("APPROVAL_BINDING_INVALID");
  if (consumed) throw new Error("APPROVAL_ALREADY_CONSUMED");
  return { approvalId: payload.approvalId, approvalCommitment: envelope.approvalCommitment };
}

function validateApproval(args) {
  if (!args.capture || !args.approvalFile) throw new Error("CAPTURE_ARGUMENTS_REQUIRED");
  if (path.resolve(ROOT, args.approvalFile) !== rel(FIXED_APPROVAL_REL)) throw new Error("APPROVAL_PATH_FORBIDDEN");
  const packageBytes = fs.readFileSync(rel(PACKAGE_MANIFEST_REL)); const packageManifest = JSON.parse(packageBytes);
  const evidenceManifest = JSON.parse(fs.readFileSync(rel(EVIDENCE_MANIFEST_REL))); const proposal = JSON.parse(fs.readFileSync(rel(PROPOSAL_REL)));
  const reviewBytes = fs.readFileSync(rel(REVIEW_MANIFEST_REL)); const review = JSON.parse(reviewBytes);
  validateEvidenceManifest(evidenceManifest); validateArtifactManifest(packageManifest, PACKAGE_ARTIFACTS, "PACKAGE");
  validateArtifactManifest(review, [PREFLIGHT_REL, REPORT_REL, PROPOSAL_REL, PACKAGE_MANIFEST_REL, EVIDENCE_MANIFEST_REL], "REVIEW");
  validateProposal(proposal); const payload = proposal.proposalPayload;
  const proposalExpected = { runnerSha256: `0x${sha256(fs.readFileSync(__filename))}`,
    packageManifestSha256: `0x${sha256(packageBytes)}`, packageAggregateSha256: `0x${packageManifest.aggregateSha256}`,
    evidenceBinding: evidenceManifest.evidenceBinding, ...commitments() };
  for (const [key, value] of Object.entries(proposalExpected)) {
    if (canonicalJson(payload[key]) !== canonicalJson(value)) throw new Error("PROPOSAL_BINDING_INVALID");
  }
  const expected = { approvalId: payload.requestedApprovalId, runnerSha256: `0x${sha256(fs.readFileSync(__filename))}`,
    packageManifestSha256: `0x${sha256(packageBytes)}`, packageAggregateSha256: `0x${packageManifest.aggregateSha256}`,
    evidenceBinding: evidenceManifest.evidenceBinding, proposalCommitment: proposal.proposalCommitment,
    reviewMaterialManifestSha256: `0x${sha256(reviewBytes)}`, ...commitments() };
  const envelope = JSON.parse(fs.readFileSync(rel(FIXED_APPROVAL_REL)));
  const result = validateApprovalEnvelope(envelope, expected, Date.now(), fs.existsSync(rel(LEDGER_REL)));
  if (fs.existsSync(rel(FIXED_OUTPUT_REL))) throw new Error("OUTPUT_EXISTS");
  return { ...result, ledgerPath: rel(LEDGER_REL), outputPath: rel(FIXED_OUTPUT_REL) };
}

function consumeApproval(authorization) {
  const fd = fs.openSync(authorization.ledgerPath, "wx");
  try { fs.writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, findingId: FINDING_ID, approvalId: authorization.approvalId,
    approvalCommitment: authorization.approvalCommitment, status: "CONSUMED_BEFORE_INVENTORY_ACCESS" }, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

async function qualify(endpoints, context) {
  const selected = endpoints.slice(0, 2); if (selected.length !== 2) return { ok: false, reason: "FAMILY_THRESHOLD", rows: [] };
  const rows = [];
  for (const endpoint of selected) {
    const chain = await rpcRequest(endpoint, "eth_chainId", [], context); if (!chain.ok || strictQuantity(chain.result) !== 1n) return { ok: false, reason: "CHAIN_MISMATCH", rows };
    const block = await rpcRequest(endpoint, "eth_getBlockByNumber", ["finalized", false], context); const header = block.ok ? parseHeader(block.result) : null;
    if (!header) return { ok: false, reason: "FINALIZED_HEADER_INVALID", rows }; rows.push({ endpoint, header });
  }
  if (!headersEqual(rows[0].header, rows[1].header)) return { ok: false, reason: "FINALIZED_PIN_MISMATCH", rows };
  return { ok: true, reason: null, rows, header: rows[0].header };
}

async function runCapture(args, dependencies = {}) {
  const caps = dependencies.caps || CAPS; const context = { caps, budget: new Budget(caps, dependencies.now), nextId: 0,
    fetchImpl: dependencies.fetchImpl };
  const authorization = (dependencies.validateApproval || validateApproval)(args); consumeApproval(authorization);
  let result;
  try {
    const endpoints = (dependencies.loadInventory || loadInventoryAuthorized)(context);
    const pin = await (dependencies.qualify || qualify)(endpoints, context); const facts = baseFacts();
    facts.hostnameDiversityFamilyCount = pin.rows.length; facts.hostnameDiversityThresholdMet = pin.ok;
    if (!pin.ok) result = failClosed(pin.reason, context.budget.summary(), facts);
    else {
      facts.fixedPinAgreement = true;
      facts.fixedPinNumber = pin.header.number.toString(); facts.fixedPinHash = pin.header.hash;
      facts.fixedPinTimestamp = pin.header.timestamp.toString(); facts.fixedPinBaseFeeWei = pin.header.baseFee.toString();
      const states = [];
      for (const row of pin.rows) {
        const codeResponse = await rpcRequest(row.endpoint, "eth_getCode", [CANDIDATE, toQuantity(pin.header.number)], context);
        const code = codeResponse.ok ? strictHex(codeResponse.result) : null;
        const balanceResponse = await rpcRequest(row.endpoint, "eth_getBalance", [CANDIDATE, toQuantity(pin.header.number)], context);
        const balance = balanceResponse.ok ? strictQuantity(balanceResponse.result) : null;
        states.push({ code, balance });
      }
      const fixedState = evaluateFixedState(states, pin.header.baseFee, dependencies.runtimeExpectation);
      facts.runtimeAgreement = fixedState.runtimeAgreement; facts.balanceAgreement = fixedState.balanceAgreement;
      if (!fixedState.ok) result = failClosed(fixedState.reason, context.budget.summary(), facts);
      else {
        facts.openingBalanceWei = states[0].balance.toString();
        const senderCodes = [];
        for (const row of pin.rows) {
          const senderCodeResponse = await rpcRequest(row.endpoint, "eth_getCode", [SENDER, toQuantity(pin.header.number)], context);
          senderCodes.push(senderCodeResponse.ok ? strictHex(senderCodeResponse.result) : null);
        }
        facts.senderCodeAgreement = senderCodes.length === 2 && senderCodes[0] === "0x" && senderCodes[1] === "0x";
        if (!facts.senderCodeAgreement) result = failClosed("SENDER_CODE_NONEMPTY_OR_MISMATCH", context.budget.summary(), facts);
        else {
        const calls = [];
        const tx = { from: SENDER, to: CANDIDATE, value: "0x0", data: CALLDATA };
        for (const row of pin.rows) calls.push(await rpcRequest(row.endpoint, "eth_call", [tx, toQuantity(pin.header.number)], context));
        if (!evaluateCallResults(calls).ok) result = failClosed("CALL_REVERT_OR_NONEMPTY", context.budget.summary(), facts);
        else {
          facts.callAgreement = true; const estimates = [];
          for (const row of pin.rows) estimates.push(await rpcRequest(row.endpoint, "eth_estimateGas", [tx, toQuantity(pin.header.number)], context));
          const estimateEvaluation = evaluateEstimateResults(estimates);
          facts.estimateA = estimates[0] && estimates[0].ok && strictQuantity(estimates[0].result) !== null
            ? strictQuantity(estimates[0].result).toString() : null;
          facts.estimateB = estimates[1] && estimates[1].ok && strictQuantity(estimates[1].result) !== null
            ? strictQuantity(estimates[1].result).toString() : null;
          if (!estimateEvaluation.ok) {
            if (estimateEvaluation.fundingQualificationRequired) {
              facts.senderBalanceDiagnosticPerformed = true; let diagnosticComplete = true;
              for (let i = 0; i < estimates.length; i++) if (estimates[i].error === "ESTIMATE_FUNDING_CHECK") {
                const diagnostic = await rpcRequest(pin.rows[i].endpoint, "eth_getBalance", [SENDER, toQuantity(pin.header.number)], context);
                if (!diagnostic.ok || strictQuantity(diagnostic.result) === null) diagnosticComplete = false;
              }
              facts.senderBalanceDiagnosticComplete = diagnosticComplete;
            }
            result = failClosed("ESTIMATE_FAILED", context.budget.summary(), facts);
          } else {
            facts.estimateBothSucceeded = true;
            facts.selectedMaxEstimate = (estimateEvaluation.estimates[0] > estimateEvaluation.estimates[1]
              ? estimateEvaluation.estimates[0] : estimateEvaluation.estimates[1]).toString();
            let terminalOk = true;
            for (const row of pin.rows) { const terminal = await rpcRequest(row.endpoint, "eth_getBlockByNumber", [toQuantity(pin.header.number), false], context);
              if (!terminal.ok || !headersEqual(pin.header, parseHeader(terminal.result))) terminalOk = false; }
            facts.terminalPinAgreement = terminalOk; facts.terminalRecheckMatched = terminalOk;
            if (!terminalOk) result = failClosed("TERMINAL_PIN_MISMATCH", context.budget.summary(), facts);
            else { context.budget.checkTime(); const economics = calculateEconomics(states[0].balance, estimateEvaluation.estimates[0], estimateEvaluation.estimates[1], pin.header.baseFee);
              result = economics.positive ? positiveResult(facts, economics, context.budget.summary()) : nonpositiveResult(facts, economics, context.budget.summary()); }
          }
        }
        }
      }
    }
  } catch (error) { result = failClosed(/^BUDGET_EXHAUSTED_/u.test(String(error.message || error)) ? "BUDGET_EXHAUSTED" : "CAPTURE_FAILURE", context.budget.summary()); }
  try { context.budget.checkTime(); } catch (_) { result = failClosed("BUDGET_EXHAUSTED", context.budget.summary()); }
  let sanitized; try { sanitized = sanitizeOutput(result); } catch (_) { sanitized = failClosed("OUTPUT_SANITIZATION_FAILED", context.budget.summary()); }
  (dependencies.writeOutput || fs.writeFileSync)(authorization.outputPath, `${JSON.stringify(sanitized, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return sanitized;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.capture) { process.stdout.write(`${JSON.stringify(dryPreflight(), null, 2)}\n`); return; }
  process.stdout.write(`${JSON.stringify(await runCapture(args), null, 2)}\n`);
}
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

module.exports = { ALLOWED_METHODS, FORBIDDEN_METHODS, CAPS, ECONOMIC_POLICY, FINDING_ID, STEM, FIXED_OUTPUT_REL, FIXED_APPROVAL_REL,
  LEDGER_REL, PACKAGE_MANIFEST_REL, EVIDENCE_MANIFEST_REL, PROPOSAL_REL, REVIEW_MANIFEST_REL, PREFLIGHT_REL, REPORT_REL,
  PACKAGE_ARTIFACTS, EVIDENCE_PATHS, COMPARATOR_RECORD, TOOLCHAIN,
  FIXED_SCOPE: Object.freeze({ candidate: CANDIDATE, sender: SENDER, calldata: CALLDATA, runtimeBytes: EXPECTED_RUNTIME_BYTES,
    runtimeHash: EXPECTED_RUNTIME_HASH }), Budget, bytes32Commitment, canonicalJson, commitments, strictQuantity, parseHeader, headersEqual,
  parseEnvelope, readStreamed, rpcRequest, loadInventoryAuthorized, calculateEconomics, failClosed, economicEvidence, nonpositiveResult, positiveResult, sanitizeOutput,
  evaluateFixedState, evaluateBalance, evaluateCallResults, evaluateEstimateResults,
  dryPreflight, parseArgs, evidenceRecords, validateEvidenceManifest, validateArtifactManifest, validateProposal, validateApprovalEnvelope,
  consumeApproval, qualify, runCapture };
