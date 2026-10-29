#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STEM = "critical-infinifi-accounting-yieldshare-redemption-conservation-step2-deployment-gate";
const FINDING_ID = STEM;
const TARGET_CHAIN_ID = 1;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const GATEWAY = "0x3f04b65ddbd87f9ce0a2e7eb24d80e7fb87625b5";
const BALANCE_CALLDATA = "0x70a082310000000000000000000000003f04b65ddbd87f9ce0a2e7eb24d80e7fb87625b5";
const INVENTORY_PATH = path.join(ROOT, "rpc_endpoints.txt");
const FIXED_OUTPUT_REL = `reports/raw/fast/${STEM}.json`;
const FIXED_APPROVAL_REL = `coordination/decisions/${STEM}-approval.json`;
const LEDGER_REL = `coordination/decisions/${STEM}-consumption-ledger.json`;
const PREFLIGHT_REL = `reports/raw/fast/${STEM}-preflight.json`;
const REPORT_REL = `reports/${STEM}-preflight.md`;
const EVIDENCE_MANIFEST_REL = `reports/raw/fast/${STEM}-evidence-manifest.json`;
const PACKAGE_MANIFEST_REL = `reports/raw/fast/${STEM}-package-manifest.json`;
const PROPOSAL_REL = `reports/raw/fast/${STEM}-approval-proposal.json`;
const REVIEW_MANIFEST_REL = `reports/raw/fast/${STEM}-review-material-manifest.json`;
const ALLOWED_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_call"]);
const FORBIDDEN_METHODS = new Set(["eth_getCode", "eth_getBalance", "eth_getLogs", "eth_getStorageAt", "debug_traceCall",
  "trace_call", "eth_estimateGas", "eth_sendTransaction", "eth_sendRawTransaction"]);
const CAPS = Object.freeze({ chains: 1, maxInventoryEntries: 16, maxInventoryBytes: 65536, maxInventoryLines: 512,
  maxCandidates: 4, requiredQualifiedFamilies: 2, maxRequestsPerCandidate: 4, maxTotalRequests: 10, retriesPerRequest: 0,
  requestTimeoutMs: 10000, maxElapsedMs: 120000, maxResponseBytes: 2097152, maxAggregateResponseBytes: 10485760,
  maxApprovalWindowMs: 600000, maxApprovalIssuedAgeMs: 180000, maxApprovalFutureSkewMs: 30000 });
const SOURCE_HASHES = Object.freeze({
  "src/gateway/InfiniFiGatewayV2.sol": "c2ea3ecf9ed0a9185e8c8cf445a09d10d8f2b8fad70d9ebb05f99c9123862574",
  "src/gateway/InfiniFiGatewayV3.sol": "d504d85fbb7c9230bf1f76d928cfdd7a2684c85ff9c7e03cab5f420cf26eb508",
  "src/core/CoreControlled.sol": "f224308d1cbbc41dc0ffe8098f587280802748275b05b723371a67eb41ec6f9f",
  "src/core/InfiniFiCore.sol": "b4c1576b2f92fb6048aa77bd5cb01289f68c398d9cb23b04af98b59889932ee0",
  "src/libraries/CoreRoles.sol": "45e8abc5bf8ed9271bd9197f5d5aff71ab33776f73ecb08ad1884b70ee0730f4",
  "src/libraries/FarmTypes.sol": "83e6f71d665573f4e6a3dbb7149452d4cd7b6d927df9a04217b5144c5c5c2217",
  "src/funding/MintController.sol": "3464c64a78df3d46b321dbe1d703704577e98a9540af9e502498e826c8ceec69",
  "src/tokens/ReceiptToken.sol": "ccdcbb173baa607e05bb9257b3c6482af5961b5fce2307e67645e9f0593e35ca",
  "src/finance/Accounting.sol": "ea76ab29a5bac2b2bd31da11d5cd125984539fbf54e5bd41b4ffdb00b62ce175",
  "src/integrations/Farm.sol": "63f3ccb57f09b6a3b8c8209027682a74264822c65a1c58eb5f402854e0e0b86d",
  "src/integrations/FarmRegistry.sol": "aa24ef353ead89846c04067e6e1afd48857f72cd629f6a6d8433442109469e49",
  "src/integrations/farms/movement/AfterMintHook.sol": "29682c0680071025e522b0bcc78509b9968a741020636dbc67c59351293c7e9e",
  "src/interfaces/IFarm.sol": "a582c415cbb6fefdcac7b58752f96bf49b2fcab5045082a8ae02495ab1781912",
  "src/interfaces/IOracle.sol": "9d1d086151a6cf67281fca4b292d7aabbb46651a081c09d05355aada0bab0aae",
  "src/interfaces/IMintController.sol": "8904417388cdecb53368bcb2637e987f0b936a04f003cf55f09e996284a0c030"
});
const SOURCE_REVIEW = Object.freeze({ targetPath: "targets/infinifi-protocol",
  targetCommit: "3f0e186553036c8ecef82b449aa07b587290a30e", copiedSourceRoot: "sources/infinifi-accounting-yieldshare-redemption-step1",
  sourceHashes: SOURCE_HASHES, allCopiedHashesMatchTarget: true, disposition: "LOW_CONDITIONAL_SOURCE_LOCAL_RESIDUE_CAPTURE",
  deployedResidueKnown: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false });
const CONFIG_BINDING = Object.freeze({ path: "targets/infinifi-protocol/deployment/configuration/addresses.1.json",
  sha256: "502df1dc483ea097c345bdc0529fe666f86ed776535b149389ec45930f0d6399", chainId: 1,
  usdcRole: "ERC20_USDC", gatewayRole: "GATEWAY_PROXY" });
const STEP1_PATHS = Object.freeze([
  "reports/critical-infinifi-accounting-yieldshare-redemption-conservation-step1.md",
  "reports/raw/fast/critical-infinifi-accounting-yieldshare-redemption-conservation-step1.json",
  "coordination/inbox/critical/20260801-critical-infinifi-accounting-step1.json",
  "coordination/handoffs/20260801-critical-infinifi-accounting-step1-handoff.md"
]);
const EVIDENCE_PATHS = Object.freeze([...STEP1_PATHS, CONFIG_BINDING.path,
  ...Object.keys(SOURCE_HASHES).map((p) => `${SOURCE_REVIEW.copiedSourceRoot}/${p}`)]);
const PACKAGE_ARTIFACTS = Object.freeze([`tools/${STEM}-runner.js`, `tools/test-${STEM}.js`, `tools/validate-${STEM}.js`,
  `tools/fixtures/${STEM}-fixtures.json`, EVIDENCE_MANIFEST_REL]);
const TOOLCHAIN = Object.freeze({ nodeVersion: process.version });
const rel = (value) => path.join(ROOT, ...value.split("/"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
function canonicalJson(value) { if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; }
const bytes32Commitment = (value) => `0x${sha256(Buffer.from(canonicalJson(value), "utf8"))}`;
const strictHex = (value, bytes = null) => typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/u.test(value) &&
  (bytes === null || value.length === bytes * 2 + 2) ? value.toLowerCase() : null;
function strictQuantity(value) { if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) return null;
  try { return BigInt(value); } catch (_) { return null; } }
const toQuantity = (value) => `0x${BigInt(value).toString(16)}`;
function commitments() { return Object.freeze({ usdcCommitment: bytes32Commitment({ role: "fixed-usdc", value: USDC }),
  gatewayCommitment: bytes32Commitment({ role: "fixed-gateway-proxy", value: GATEWAY }),
  balanceCallCommitment: bytes32Commitment({ role: "usdc-balanceOf-gateway", bytes: 36, value: BALANCE_CALLDATA }),
  methodsCommitment: bytes32Commitment([...ALLOWED_METHODS].sort()), capsCommitment: bytes32Commitment(CAPS),
  configCommitment: bytes32Commitment(CONFIG_BINDING), sourceReviewCommitment: bytes32Commitment(SOURCE_REVIEW) }); }
function assertExactKeys(value, expected, code) { if (!value || typeof value !== "object" || Array.isArray(value) ||
  canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) throw new Error(code); }

class Budget {
  constructor(caps = CAPS, now = () => Date.now()) { this.caps = caps; this.now = now; this.startedAt = now(); this.total = 0;
    this.perCandidate = {}; this.selected = new Set(); this.chainIdRequests = 0; this.responseBytes = 0; this.exhausted = null; }
  fail(code) { this.exhausted = code; throw new Error(`BUDGET_EXHAUSTED_${code}`); }
  checkTime() { if (this.now() - this.startedAt > this.caps.maxElapsedMs) this.fail("TIME"); }
  consume(candidate, method) { this.checkTime(); if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) throw new Error("METHOD_FORBIDDEN");
    this.total += 1; this.perCandidate[candidate] = (this.perCandidate[candidate] || 0) + 1;
    if (method === "eth_chainId") this.chainIdRequests += 1;
    if (this.total > this.caps.maxTotalRequests) this.fail("TOTAL_REQUESTS");
    if (this.perCandidate[candidate] > this.caps.maxRequestsPerCandidate) this.fail("CANDIDATE_REQUESTS"); }
  consumeBytes(bytes) { this.responseBytes += bytes; if (this.responseBytes > this.caps.maxAggregateResponseBytes) this.fail("AGGREGATE_RESPONSE_BYTES"); }
  markSelected(ids) { ids.forEach((id) => this.selected.add(id)); }
  summary() { const ids = Object.keys(this.perCandidate).sort(); const elapsedWithinCap = this.now() - this.startedAt <= this.caps.maxElapsedMs;
    return { total: this.total, candidateRequestCounts: ids.map((id) => this.perCandidate[id]),
      selectedFamilyRequestCounts: ids.filter((id) => this.selected.has(id)).map((id) => this.perCandidate[id]),
      rejectedCandidateRequestCounts: ids.filter((id) => !this.selected.has(id)).map((id) => this.perCandidate[id]),
      chainIdRequestCount: this.chainIdRequests, responseBytes: this.responseBytes, exhausted: this.exhausted,
      elapsedWithinCap, allWithinCaps: this.exhausted === null && elapsedWithinCap }; }
}
function parseEnvelope(body, expectedId) { let parsed; try { parsed = JSON.parse(body); } catch (_) { return { ok: false, error: "MALFORMED_JSON", result: null }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.jsonrpc !== "2.0" || parsed.id !== expectedId)
    return { ok: false, error: "ENVELOPE_MISMATCH", result: null };
  if (Object.prototype.hasOwnProperty.call(parsed, "error")) return { ok: false, error: "RPC_ERROR", result: null };
  if (!Object.prototype.hasOwnProperty.call(parsed, "result")) return { ok: false, error: "MISSING_RESULT", result: null };
  return { ok: true, error: null, result: parsed.result }; }
async function readStreamed(response, context, controller) { if (!response.body || typeof response.body.getReader !== "function") {
  controller.abort(); throw new Error("STREAMING_BODY_REQUIRED"); } const reader = response.body.getReader(); const chunks = []; let total = 0;
  while (true) { context.budget.checkTime(); const row = await reader.read(); if (row.done) break; const chunk = Buffer.from(row.value); total += chunk.length;
    if (total > context.caps.maxResponseBytes) { controller.abort(); await reader.cancel(); context.budget.fail("SINGLE_RESPONSE_BYTES"); }
    try { context.budget.consumeBytes(chunk.length); } catch (error) { controller.abort(); await reader.cancel(); throw error; } chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8"); }
async function rpcRequest(endpoint, method, params, context, fetchImpl = context.fetchImpl || fetch) {
  if (!ALLOWED_METHODS.has(method) || FORBIDDEN_METHODS.has(method)) return { ok: false, error: "METHOD_FORBIDDEN", result: null };
  context.budget.consume(endpoint.family, method); const id = ++context.nextId; const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.caps.requestTimeoutMs);
  try { const response = await fetchImpl(endpoint.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: controller.signal });
    if (response.redirected || response.status < 200 || response.status >= 300) { controller.abort();
      if (response.body && typeof response.body.getReader === "function") try { await response.body.getReader().cancel(); } catch (_) {}
      return { ok: false, error: "HTTP_FAILURE", result: null }; }
    const declared = response.headers && response.headers.get ? Number(response.headers.get("content-length")) : 0;
    if (declared > context.caps.maxResponseBytes) { controller.abort(); context.budget.fail("SINGLE_RESPONSE_BYTES"); }
    return parseEnvelope(await readStreamed(response, context, controller), id);
  } catch (error) { if (/^BUDGET_EXHAUSTED_|STREAMING_BODY_REQUIRED/u.test(String(error.message || error))) throw error;
    return { ok: false, error: "TRANSPORT_FAILURE", result: null }; } finally { clearTimeout(timer); } }
function parseHeader(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const number = strictQuantity(value.number), hash = strictHex(value.hash, 32), timestamp = strictQuantity(value.timestamp), baseFee = strictQuantity(value.baseFeePerGas);
  return number === null || !hash || timestamp === null || baseFee === null || baseFee <= 0n ? null : { number, hash, timestamp, baseFee }; }
const headersEqual = (a, b) => Boolean(a && b && a.number === b.number && a.hash === b.hash && a.timestamp === b.timestamp && a.baseFee === b.baseFee);
function loadInventoryAuthorized(context, inventoryPath = INVENTORY_PATH) { context.budget.checkTime(); const stat = fs.statSync(inventoryPath);
  if (stat.size > context.caps.maxInventoryBytes) throw new Error("INVENTORY_BYTES_EXCEEDED"); const content = fs.readFileSync(inventoryPath, "utf8");
  const lines = content.split(/\r?\n/u); if (lines.length > context.caps.maxInventoryLines) throw new Error("INVENTORY_LINES_EXCEEDED");
  const endpoints = [], hosts = new Set(); let entries = 0;
  for (const line of lines) { context.budget.checkTime(); const match = line.match(/https:\/\/[^\s'"<>\[\]]+/u); if (!match) continue;
    let parsed; try { parsed = new URL(match[0].replace(/[)\]]+$/u, "")); } catch (_) { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || /testnet|sepolia|hoodi|gnosis|chiado/iu.test(parsed.href)) continue;
    entries += 1; if (entries > context.caps.maxInventoryEntries) throw new Error("INVENTORY_ENTRIES_EXCEEDED");
    const host = parsed.hostname.toLowerCase(); if (hosts.has(host)) continue; hosts.add(host); endpoints.push({ url: parsed.href, family: `C${hosts.size}` });
    if (endpoints.length >= context.caps.maxCandidates) break; } return endpoints; }
async function qualify(endpoints, context) { const rows = [], counters = { candidatesExamined: 0, queryFailures: 0, malformed: 0, observedNonTarget: 0 };
  for (const endpoint of endpoints.slice(0, context.caps.maxCandidates)) { counters.candidatesExamined += 1;
    const chain = await rpcRequest(endpoint, "eth_chainId", [], context); if (!chain.ok) {
      if (["MALFORMED_JSON", "ENVELOPE_MISMATCH", "MISSING_RESULT"].includes(chain.error)) counters.malformed += 1; else counters.queryFailures += 1; continue; }
    const observed = strictQuantity(chain.result); if (observed === null) { counters.malformed += 1; continue; }
    if (observed !== BigInt(TARGET_CHAIN_ID)) { counters.observedNonTarget += 1; continue; } rows.push({ endpoint });
    if (rows.length === context.caps.requiredQualifiedFamilies) break; }
  context.budget.markSelected(rows.map((row) => row.endpoint.family));
  if (rows.length === context.caps.requiredQualifiedFamilies) return { ok: true, reason: null, rows, counters };
  let reason = rows.length === 1 ? "QUALIFICATION_ONLY_ONE_ELIGIBLE_FAMILY" : "QUALIFICATION_CANDIDATES_EXHAUSTED";
  if (rows.length === 0 && counters.queryFailures > 0 && counters.malformed === 0 && counters.observedNonTarget === 0) reason = "CHAIN_ID_QUERY_FAILURES_EXHAUSTED";
  if (rows.length === 0 && counters.malformed > 0 && counters.queryFailures === 0 && counters.observedNonTarget === 0) reason = "CHAIN_ID_MALFORMED_EXHAUSTED";
  if (rows.length === 0 && counters.observedNonTarget > 0 && counters.queryFailures === 0 && counters.malformed === 0) reason = "NON_TARGET_CHAIN_CANDIDATES_EXHAUSTED";
  return { ok: false, reason, rows, counters }; }
function baseFacts() { return { targetChainId: TARGET_CHAIN_ID, qualificationCandidatesExamined: 0, chainIdQueryFailureCount: 0,
  chainIdMalformedCount: 0, observedNonTargetChainCount: 0, qualifiedTargetChainFamilyCount: 0, selectedFamilyCount: 0,
  hostnameDiversityThresholdMet: false, backendIndependenceProven: false, tokenRole: "fixed-usdc", gatewayRole: "fixed-gateway-proxy",
  commitments: commitments(), fixedPinAgreement: false, fixedPinNumber: null, fixedPinHash: null, fixedPinTimestamp: null,
  fixedPinBaseFeeWei: null, balanceAgreement: false, balanceRaw: null, balanceDecimals: 6, balanceIsZero: null, balancePositive: null,
  residueClassification: null, terminalPinAgreement: false, toolchain: TOOLCHAIN }; }
function applyQualificationFacts(facts, q) { facts.qualificationCandidatesExamined = q.counters.candidatesExamined;
  facts.chainIdQueryFailureCount = q.counters.queryFailures; facts.chainIdMalformedCount = q.counters.malformed;
  facts.observedNonTargetChainCount = q.counters.observedNonTarget; facts.qualifiedTargetChainFamilyCount = q.rows.length;
  facts.selectedFamilyCount = q.ok ? q.rows.length : 0; facts.hostnameDiversityThresholdMet = q.ok; }
const gates = () => ({ routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false });
function failClosed(reasonCode, budget, facts = baseFacts()) { return { schemaVersion: 1, findingId: FINDING_ID,
  status: "INCOMPLETE_FAIL_CLOSED", reasonCode, liveCaptureExecuted: true, resultPromoted: false, facts, operationalGates: gates(), budget }; }
function balanceResult(facts, balance, budget) { const zero = balance === 0n;
  facts.balanceRaw = balance.toString(); facts.balanceIsZero = zero; facts.balancePositive = !zero;
  facts.residueClassification = zero ? "CURRENT-ZERO-RESIDUE/NO-CURRENT-CAPTURE" : "NONZERO-FIXED-PIN-RESIDUE/CONFIG-REVIEW-REQUIRED";
  return { schemaVersion: 1, findingId: FINDING_ID, status: zero ? "CURRENT_ZERO_RESIDUE_NO_CURRENT_CAPTURE" : "NONZERO_FIXED_PIN_RESIDUE_CONFIG_REVIEW_REQUIRED",
    reasonCode: null, liveCaptureExecuted: true, resultPromoted: false, facts, operationalGates: gates(), budget }; }
function sanitizeOutput(value) { const text = canonicalJson(value); if (/(?:https?|wss?):\/\//iu.test(text) || /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/u.test(text))
  throw new Error("OUTPUT_ADDRESS_OR_URL_LEAK"); const forbidden = /^(?:hostname|providerIdentity|providerHash|endpointHash|rawResponse|transactionHash|txHash|calldata|address|from|to)$/iu;
  const stack = [value]; while (stack.length) { const current = stack.pop(); if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) { if (forbidden.test(key)) throw new Error("OUTPUT_FORBIDDEN_KEY"); if (child && typeof child === "object") stack.push(child); } }
  return value; }
function dryPreflight() { return { schemaVersion: 1, findingId: FINDING_ID, status: "REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED",
  target: { targetChainId: 1, targetChainCount: 1 }, authorization: { fixedApprovalPath: FIXED_APPROVAL_REL, fixedOutputPath: FIXED_OUTPUT_REL,
    globalConsumptionLedger: LEDGER_REL, captureFlagRequired: "--capture-once", singleUseFreshApprovalRequired: true,
    approvalAuthenticityAssumption: "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM", authorized: false, captureExecuted: false },
  scope: { tokenRole: "fixed-usdc", gatewayRole: "fixed-gateway-proxy", stateQuery: "USDC.balanceOf(GATEWAY_PROXY)",
    balanceDecimals: 6, commitments: commitments() }, providerPolicy: { maxHostnameDistinctCandidates: 4,
    requiredQualifiedTargetChainFamilies: 2, backendIndependenceProven: false }, methods: { allowed: [...ALLOWED_METHODS].sort(),
    forbidden: [...FORBIDDEN_METHODS].sort() }, caps: CAPS, sourceReview: SOURCE_REVIEW, configuration: CONFIG_BINDING, toolchain: TOOLCHAIN,
  gates: gates(), networkReads: 0, inventoryReads: 0, writes: 0 }; }
function parseArgs(argv) { const args = { capture: false, checkOnly: false, approvalFile: null };
  for (let i = 2; i < argv.length; i++) { const value = argv[i]; if (value === "--capture-once") args.capture = true;
    else if (value === "--check-only" || value === "--preflight") args.checkOnly = true;
    else if (value === "--approval-file") args.approvalFile = argv[++i] || null; else throw new Error("UNKNOWN_ARGUMENT"); }
  if (args.capture && args.checkOnly) throw new Error("MODE_CONFLICT"); if (!args.capture) args.checkOnly = true; return args; }
function evidenceRecords() { return EVIDENCE_PATHS.map((artifactPath) => { const bytes = fs.readFileSync(rel(artifactPath));
  return { path: artifactPath, bytes: bytes.length, sha256: sha256(bytes) }; }); }
function validateSourceBindings() { const step1 = JSON.parse(fs.readFileSync(rel(STEP1_PATHS[1])));
  if (step1.target.commit !== SOURCE_REVIEW.targetCommit || canonicalJson(step1.exactCopiedSourceHashesSha256) !== canonicalJson(SOURCE_HASHES) ||
    step1.allCopiedHashesMatchTarget !== true) throw new Error("STEP1_SOURCE_REVIEW_MISMATCH");
  for (const [sourcePath, expected] of Object.entries(SOURCE_HASHES)) if (sha256(fs.readFileSync(rel(`${SOURCE_REVIEW.copiedSourceRoot}/${sourcePath}`))) !== expected)
    throw new Error("SOURCE_HASH_MISMATCH");
  const configBytes = fs.readFileSync(rel(CONFIG_BINDING.path)); if (sha256(configBytes) !== CONFIG_BINDING.sha256) throw new Error("CONFIG_HASH_MISMATCH");
  const config = JSON.parse(configBytes); const byName = (name) => config.filter((row) => row && row.name === name);
  if (byName(CONFIG_BINDING.usdcRole).length !== 1 || byName(CONFIG_BINDING.gatewayRole).length !== 1 ||
    byName(CONFIG_BINDING.usdcRole)[0].addr.toLowerCase() !== USDC || byName(CONFIG_BINDING.gatewayRole)[0].addr.toLowerCase() !== GATEWAY)
    throw new Error("CONFIG_VALUE_MISMATCH"); return true; }
function validateEvidenceManifest(manifest) { assertExactKeys(manifest, ["schemaVersion", "findingId", "status", "algorithm", "artifactCount",
  "aggregateSha256", "artifacts", "evidenceBinding", "configurationBinding", "sourceReview", "sourceReviewCommitment", "toolchain"], "EVIDENCE_SCHEMA");
  validateSourceBindings(); const records = evidenceRecords(), aggregate = sha256(Buffer.from(records.map((row) => `${row.path}:${row.sha256}`).sort().join("\n")));
  if (manifest.schemaVersion !== 1 || manifest.findingId !== FINDING_ID || manifest.status !== "LOCAL_EVIDENCE_BOUND" || manifest.algorithm !== "sha256" ||
    manifest.artifactCount !== records.length || canonicalJson(manifest.artifacts) !== canonicalJson(records) || manifest.aggregateSha256 !== aggregate ||
    manifest.evidenceBinding !== bytes32Commitment(records) || canonicalJson(manifest.configurationBinding) !== canonicalJson(CONFIG_BINDING) ||
    canonicalJson(manifest.sourceReview) !== canonicalJson(SOURCE_REVIEW) || manifest.sourceReviewCommitment !== bytes32Commitment(SOURCE_REVIEW) ||
    canonicalJson(manifest.toolchain) !== canonicalJson(TOOLCHAIN)) throw new Error("EVIDENCE_MISMATCH"); return true; }
function validateArtifactManifest(manifest, expectedPaths, code) { assertExactKeys(manifest, ["schemaVersion", "findingId", "status", "algorithm",
  "artifactCount", "aggregateSha256", "artifacts"], `${code}_SCHEMA`);
  if (!Array.isArray(manifest.artifacts) || canonicalJson(manifest.artifacts.map((r) => r.path).sort()) !== canonicalJson([...expectedPaths].sort())) throw new Error(`${code}_PATHS`);
  for (const row of manifest.artifacts) { assertExactKeys(row, ["path", "bytes", "sha256"], `${code}_ROW`); const bytes = fs.readFileSync(rel(row.path));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) throw new Error(`${code}_ARTIFACT`); }
  const aggregate = sha256(Buffer.from(manifest.artifacts.map((r) => `${r.path}:${r.sha256}`).sort().join("\n")));
  if (manifest.schemaVersion !== 1 || manifest.findingId !== FINDING_ID || manifest.status !== "REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED" ||
    manifest.algorithm !== "sha256" || manifest.artifactCount !== expectedPaths.length || manifest.aggregateSha256 !== aggregate) throw new Error(`${code}_MISMATCH`); return true; }
function validateProposal(proposal) { assertExactKeys(proposal, ["schemaVersion", "state", "authorization", "captureExecuted", "proposalPayload",
  "proposalCommitment", "reviewerIssuedApprovalRequirements", "networkReads", "inventoryReads", "approvalCreated"], "PROPOSAL_SCHEMA");
  const payloadKeys = ["requestedApprovalId", "findingId", "targetChainId", "authorizedCaptureCount", "fixedApprovalPath", "fixedOutputPath",
    "globalConsumptionLedger", "runnerSha256", "packageManifestSha256", "packageAggregateSha256", "evidenceBinding", "usdcCommitment",
    "gatewayCommitment", "balanceCallCommitment", "methodsCommitment", "capsCommitment", "configCommitment", "sourceReviewCommitment",
    "allowedMethods", "approvalAuthenticityAssumption"];
  assertExactKeys(proposal.proposalPayload, payloadKeys, "PROPOSAL_PAYLOAD_SCHEMA"); assertExactKeys(proposal.reviewerIssuedApprovalRequirements,
    ["schemaVersion", "state", "requestedApprovalId", "issuedAt", "expiresAt", "approvalCommitment", "reviewMaterialManifestSha256",
      "endpointInventoryReadAuthorized", "transactionsAuthorized", "traceAuthorized", "forkAuthorized", "independentReviewRequired"], "PROPOSAL_REVIEW_SCHEMA");
  const p = proposal.proposalPayload, review = proposal.reviewerIssuedApprovalRequirements;
  if (proposal.schemaVersion !== 1 || proposal.state !== "REVIEW_REQUESTED" || proposal.authorization !== "NOT_AUTHORIZED" || proposal.captureExecuted !== false ||
    proposal.networkReads !== 0 || proposal.inventoryReads !== 0 || proposal.approvalCreated !== false || !/^infinifi-step2-[0-9a-f]{32}$/u.test(p.requestedApprovalId || "") ||
    p.findingId !== FINDING_ID || p.targetChainId !== 1 || p.authorizedCaptureCount !== 1 || p.fixedApprovalPath !== FIXED_APPROVAL_REL ||
    p.fixedOutputPath !== FIXED_OUTPUT_REL || p.globalConsumptionLedger !== LEDGER_REL || canonicalJson(p.allowedMethods) !== canonicalJson([...ALLOWED_METHODS].sort()) ||
    p.approvalAuthenticityAssumption !== "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM" || proposal.proposalCommitment !== bytes32Commitment(p)) throw new Error("PROPOSAL_INVALID");
  if (review.schemaVersion !== 2 || review.state !== "AUTHORIZED" || review.requestedApprovalId !== p.requestedApprovalId || review.issuedAt !== null ||
    review.expiresAt !== null || review.approvalCommitment !== null || review.reviewMaterialManifestSha256 !== null || review.endpointInventoryReadAuthorized !== true ||
    review.transactionsAuthorized !== false || review.traceAuthorized !== false || review.forkAuthorized !== false || review.independentReviewRequired !== true)
    throw new Error("PROPOSAL_REVIEW_INVALID"); return true; }
function validateApprovalEnvelope(envelope, expected, now = Date.now(), consumed = false) { assertExactKeys(envelope,
  ["schemaVersion", "state", "approvalPayload", "approvalCommitment"], "APPROVAL_SCHEMA");
  const keys = ["approvalId", "findingId", "targetChainId", "issuedAt", "expiresAt", "authorizedCaptureCount", "fixedApprovalPath", "fixedOutputPath",
    "globalConsumptionLedger", "endpointInventoryReadAuthorized", "transactionsAuthorized", "traceAuthorized", "forkAuthorized", "runnerSha256",
    "packageManifestSha256", "packageAggregateSha256", "evidenceBinding", "proposalCommitment", "reviewMaterialManifestSha256", "usdcCommitment",
    "gatewayCommitment", "balanceCallCommitment", "methodsCommitment", "capsCommitment", "configCommitment", "sourceReviewCommitment", "allowedMethods",
    "approvalAuthenticityAssumption"]; const p = envelope.approvalPayload; assertExactKeys(p, keys, "APPROVAL_PAYLOAD_SCHEMA");
  if (envelope.schemaVersion !== 2 || envelope.state !== "AUTHORIZED" || !/^infinifi-step2-[0-9a-f]{32}$/u.test(p.approvalId || "") ||
    envelope.approvalCommitment !== bytes32Commitment(p)) throw new Error("APPROVAL_INVALID");
  const issued = Date.parse(p.issuedAt), expires = Date.parse(p.expiresAt); if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued ||
    expires - issued > CAPS.maxApprovalWindowMs || now - issued > CAPS.maxApprovalIssuedAgeMs || issued > now + CAPS.maxApprovalFutureSkewMs || now >= expires)
    throw new Error("APPROVAL_WINDOW_INVALID");
  const required = { findingId: FINDING_ID, targetChainId: 1, authorizedCaptureCount: 1, fixedApprovalPath: FIXED_APPROVAL_REL,
    fixedOutputPath: FIXED_OUTPUT_REL, globalConsumptionLedger: LEDGER_REL, endpointInventoryReadAuthorized: true, transactionsAuthorized: false,
    traceAuthorized: false, forkAuthorized: false, allowedMethods: [...ALLOWED_METHODS].sort(), approvalAuthenticityAssumption: "TRUSTED_COORDINATOR_AND_LOCAL_FILESYSTEM", ...expected };
  for (const [key, value] of Object.entries(required)) if (canonicalJson(p[key]) !== canonicalJson(value)) throw new Error("APPROVAL_BINDING_INVALID");
  if (consumed) throw new Error("APPROVAL_ALREADY_CONSUMED"); return { approvalId: p.approvalId, approvalCommitment: envelope.approvalCommitment }; }
function validateApproval(args) { if (!args.capture || !args.approvalFile) throw new Error("CAPTURE_ARGUMENTS_REQUIRED");
  if (path.resolve(ROOT, args.approvalFile) !== rel(FIXED_APPROVAL_REL)) throw new Error("APPROVAL_PATH_FORBIDDEN");
  const packageBytes = fs.readFileSync(rel(PACKAGE_MANIFEST_REL)), packageManifest = JSON.parse(packageBytes), evidence = JSON.parse(fs.readFileSync(rel(EVIDENCE_MANIFEST_REL))),
    proposal = JSON.parse(fs.readFileSync(rel(PROPOSAL_REL))), reviewBytes = fs.readFileSync(rel(REVIEW_MANIFEST_REL),), review = JSON.parse(reviewBytes);
  validateEvidenceManifest(evidence); validateArtifactManifest(packageManifest, PACKAGE_ARTIFACTS, "PACKAGE"); validateProposal(proposal);
  validateArtifactManifest(review, [PREFLIGHT_REL, REPORT_REL, PROPOSAL_REL, PACKAGE_MANIFEST_REL, EVIDENCE_MANIFEST_REL], "REVIEW");
  const p = proposal.proposalPayload, expectedProposal = { runnerSha256: `0x${sha256(fs.readFileSync(__filename))}`,
    packageManifestSha256: `0x${sha256(packageBytes)}`, packageAggregateSha256: `0x${packageManifest.aggregateSha256}`,
    evidenceBinding: evidence.evidenceBinding, ...commitments() };
  for (const [key, value] of Object.entries(expectedProposal)) if (canonicalJson(p[key]) !== canonicalJson(value)) throw new Error("PROPOSAL_BINDING_INVALID");
  const expected = { approvalId: p.requestedApprovalId, ...expectedProposal, proposalCommitment: proposal.proposalCommitment,
    reviewMaterialManifestSha256: `0x${sha256(reviewBytes)}` }; const envelope = JSON.parse(fs.readFileSync(rel(FIXED_APPROVAL_REL)));
  const result = validateApprovalEnvelope(envelope, expected, Date.now(), fs.existsSync(rel(LEDGER_REL)));
  if (fs.existsSync(rel(FIXED_OUTPUT_REL))) throw new Error("OUTPUT_EXISTS"); return { ...result, ledgerPath: rel(LEDGER_REL), outputPath: rel(FIXED_OUTPUT_REL) }; }
function consumeApproval(auth) { const fd = fs.openSync(auth.ledgerPath, "wx"); try { fs.writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1,
  findingId: FINDING_ID, approvalId: auth.approvalId, approvalCommitment: auth.approvalCommitment, status: "CONSUMED_BEFORE_INVENTORY_ACCESS" }, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); } }
async function runCapture(args, dependencies = {}) { const caps = dependencies.caps || CAPS, context = { caps, budget: new Budget(caps, dependencies.now), nextId: 0,
  fetchImpl: dependencies.fetchImpl }; const auth = (dependencies.validateApproval || validateApproval)(args); consumeApproval(auth); let facts = baseFacts(), result;
  try { const endpoints = (dependencies.loadInventory || loadInventoryAuthorized)(context), q = await (dependencies.qualify || qualify)(endpoints, context);
    applyQualificationFacts(facts, q); if (!q.ok) result = failClosed(q.reason, context.budget.summary(), facts); else {
      const rows = []; for (const row of q.rows) { const block = await rpcRequest(row.endpoint, "eth_getBlockByNumber", ["finalized", false], context);
        const header = block.ok ? parseHeader(block.result) : null; if (!header) { result = failClosed("FINALIZED_HEADER_INVALID", context.budget.summary(), facts); break; }
        rows.push({ endpoint: row.endpoint, header }); }
      if (!result && !headersEqual(rows[0].header, rows[1].header)) result = failClosed("FINALIZED_PIN_MISMATCH", context.budget.summary(), facts);
      if (!result) { const header = rows[0].header; facts.fixedPinAgreement = true; facts.fixedPinNumber = header.number.toString(); facts.fixedPinHash = header.hash;
        facts.fixedPinTimestamp = header.timestamp.toString(); facts.fixedPinBaseFeeWei = header.baseFee.toString(); const balances = [];
        for (const row of rows) { const call = await rpcRequest(row.endpoint, "eth_call", [{ to: USDC, data: BALANCE_CALLDATA }, toQuantity(header.number)], context);
          const encoded = call.ok ? strictHex(call.result, 32) : null; balances.push(encoded === null ? null : BigInt(encoded)); }
        if (balances[0] === null || balances[1] === null) result = failClosed("BALANCE_RESULT_MALFORMED", context.budget.summary(), facts);
        else if (balances[0] !== balances[1]) result = failClosed("BALANCE_MISMATCH", context.budget.summary(), facts);
        else { facts.balanceAgreement = true; let terminalOk = true;
          for (const row of rows) { const terminal = await rpcRequest(row.endpoint, "eth_getBlockByNumber", [toQuantity(header.number), false], context);
            if (!terminal.ok || !headersEqual(header, parseHeader(terminal.result))) terminalOk = false; }
          facts.terminalPinAgreement = terminalOk; result = terminalOk ? balanceResult(facts, balances[0], context.budget.summary()) :
            failClosed("TERMINAL_PIN_MISMATCH", context.budget.summary(), facts); } } }
  } catch (error) { result = failClosed(/^BUDGET_EXHAUSTED_/u.test(String(error.message || error)) ? "BUDGET_EXHAUSTED" : "CAPTURE_FAILURE", context.budget.summary(), facts); }
  try { context.budget.checkTime(); } catch (_) { result = failClosed("BUDGET_EXHAUSTED", context.budget.summary(), facts); }
  let sanitized; try { sanitized = sanitizeOutput(result); } catch (_) { sanitized = failClosed("OUTPUT_SANITIZATION_FAILED", context.budget.summary(), facts); }
  (dependencies.writeOutput || fs.writeFileSync)(auth.outputPath, `${JSON.stringify(sanitized, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); return sanitized; }
async function main() { const args = parseArgs(process.argv); if (!args.capture) { process.stdout.write(`${JSON.stringify(dryPreflight(), null, 2)}\n`); return; }
  process.stdout.write(`${JSON.stringify(await runCapture(args), null, 2)}\n`); }
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });
module.exports = { STEM, FINDING_ID, ALLOWED_METHODS, FORBIDDEN_METHODS, CAPS, SOURCE_HASHES, SOURCE_REVIEW, CONFIG_BINDING, STEP1_PATHS,
  EVIDENCE_PATHS, PACKAGE_ARTIFACTS, TOOLCHAIN, FIXED_OUTPUT_REL, FIXED_APPROVAL_REL, LEDGER_REL, PREFLIGHT_REL, REPORT_REL,
  EVIDENCE_MANIFEST_REL, PACKAGE_MANIFEST_REL, PROPOSAL_REL, REVIEW_MANIFEST_REL, FIXED_SCOPE: Object.freeze({ usdc: USDC, gateway: GATEWAY,
    balanceCalldata: BALANCE_CALLDATA }), Budget, canonicalJson, bytes32Commitment, commitments, strictQuantity, parseEnvelope, readStreamed, rpcRequest,
  parseHeader, headersEqual, loadInventoryAuthorized, qualify, baseFacts, applyQualificationFacts, failClosed, balanceResult, sanitizeOutput, dryPreflight,
  parseArgs, evidenceRecords, validateSourceBindings, validateEvidenceManifest, validateArtifactManifest, validateProposal, validateApprovalEnvelope,
  validateApproval, consumeApproval, runCapture };
