#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./run-critical-across-hyperevm-cctp-build-recovery-step5.js");
const fixtureModule = require("./test-critical-across-hyperevm-cctp-build-recovery-step5.js");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-across-hyperevm-cctp-build-recovery-step5";
const AGENT = "reviewer-across-hyperevm-cctp-build-recovery-step5-20260725";
const CLAIM = "coordination/claims/critical-across-hyperevm-cctp-build-recovery-step5--0ab204b3.json";
const STEP4_MANIFEST = "reports/raw/fast/critical-across-hyperevm-cctp-build-recovery-step4-manifest.json";
const STEP4_AGGREGATE = runner.STEP4_AGGREGATE;
const PROPOSAL = `reports/raw/fast/${NAME}-proposal.json`, RAW = `reports/raw/fast/${NAME}.json`, TESTS = `reports/raw/fast/${NAME}-tests.json`, LEAK = `reports/raw/fast/${NAME}-leak-scan.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`;
const SCANNER = `tools/scan-${NAME}.js`, RUNNER = `tools/run-${NAME}.js`, TEST_SOURCE = `tools/test-${NAME}.js`, VALIDATOR = `tools/validate-${NAME}.js`;
const INBOX = `coordination/inbox/review-${NAME}-2026-07-25.json`, HANDOFF = `coordination/handoffs/2026-07-25-${NAME}-handoff.md`;
const STATUS = "REVIEW_REQUESTED/NOT_AUTHORIZED/NOT_EXECUTED";
const CLASSIFICATION = "REVIEW-ONLY/STEP5/SINGLE-PUBLIC-CID-RAW-BLOCK-RETRIEVAL-PROPOSAL/HASH-BEFORE-DECODE-OR-PERSIST/MOCK-VALIDATED";
const DECISION = `APPROVE, REJECT, or REQUEST_CHANGES for exactly one future public trustless-gateway raw-block GET of CID ${runner.ACTIVE_CID} using the hash-bound Step5 runner. Approval must bind the proposal run ID, package aggregate, runner SHA-256, CID, digest, decision timestamp, unique execution ID, and exactlyOneExecution=true; execution must start within 15 minutes.`;

const abs = (rel) => path.join(ROOT, rel), read = (rel) => fs.readFileSync(abs(rel)), json = (rel) => JSON.parse(read(rel).toString("utf8"));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = runner.canonical;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = read(rel); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const write = (rel, body) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, "utf8"); };

function assertActiveClaim() {
  const claim = json(CLAIM);
  if (claim.resource !== "critical/across-hyperevm-cctp-build-recovery-step5" || claim.agentId !== AGENT || claim.status !== "active" || Date.parse(claim.expiresAt) <= Date.now()) throw new Error("active-claim-invalid");
  return hashFile(CLAIM);
}

function predecessorBinding() {
  const manifest = json(STEP4_MANIFEST);
  if (manifest.aggregateSha256 !== STEP4_AGGREGATE || manifest.activePayloadCount !== 0) throw new Error("step4-approved-aggregate-mismatch");
  const records = manifest.records.map((record) => { const actual = hashFile(record.path); if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) throw new Error(`step4-record-mismatch:${record.path}`); return actual; });
  if (runner.aggregateRecords(records) !== STEP4_AGGREGATE) throw new Error("step4-record-aggregate-mismatch");
  return canonical({ status: "APPROVED-STEP4-OFFLINE-NEGATIVE-SEARCH", step4AggregateSha256: STEP4_AGGREGATE, manifest: hashFile(STEP4_MANIFEST), recordCount: records.length, records, recursiveAggregateSha256: runner.aggregateRecords([hashFile(STEP4_MANIFEST), ...records]) });
}

function leakScan(paths) {
  const findings = [];
  for (const rel of paths) {
    const body = read(rel).toString("utf8");
    if (/(?:https?|wss?):\/\//i.test(body)) findings.push({ path: rel, category: "url-persisted" });
    if (/\?format=raw/i.test(body)) findings.push({ path: rel, category: "gateway-query-persisted" });
    if (/\b(?:authorization|x-api-key|api-key)\s*[:=]\s*["'][^"']+/i.test(body)) findings.push({ path: rel, category: "credential-header-value" });
  }
  return canonical({ schemaVersion: 1, scannedPaths: paths, findingCount: findings.length, findings, passed: findings.length === 0, responseHeadersPersisted: false, gatewayQueryPersisted: false, endpointInventoryRead: false });
}

async function main() {
  for (const rel of [PROPOSAL, RAW, TESTS, LEAK, MANIFEST, REPORT, INBOX, HANDOFF]) if (fs.existsSync(abs(rel))) fs.rmSync(abs(rel), { force: true });
  const claim = assertActiveClaim(), predecessor = predecessorBinding(), fixtures = await fixtureModule.runFixtures();
  if (!fixtures.passed || fixtures.fixturesPassed !== 13 || fixtures.networkRequests !== 0) throw new Error("fixture-suite-failed");
  const runnerHash = hashFile(RUNNER), approvalSchema = canonical({
    fixedPath: runner.APPROVAL_REL,
    requiredFields: { schemaVersion: 1, decision: "APPROVED", decisionTimestamp: "RFC3339 timestamp", executionId: "64 lowercase hex characters", exactlyOneExecution: true, proposalRunId: "manifest runId", packageManifestAggregateSha256: "manifest aggregateSha256", runnerSha256: runnerHash.sha256, cid: runner.ACTIVE_CID, digestSha256: runner.ACTIVE_DIGEST },
    startWindowMs: runner.POLICY.approvalStartWindowMs,
    staleFutureOrWrongBindingFailsBeforeExecutionGuardAndTransport: true,
  });
  const transport = canonical({
    gatewayId: "public-ipfs-io-trustless-raw",
    fixedPublicGateway: true,
    fixedRawBlockPathForActiveCid: true,
    gatewayUrlPersisted: false,
    gatewayQueryPersisted: false,
    method: "GET",
    redirectMode: runner.POLICY.redirects,
    redirectsRejected: true,
    exactRequestCap: runner.POLICY.maxRequests,
    streamedResponseHardCapBytes: runner.POLICY.maxResponseBytes,
    timeoutMs: runner.POLICY.requestTimeoutMs,
    retries: runner.POLICY.retries,
    cidEnumeration: false,
    recursiveRetrieval: false,
    rpcCalls: 0,
    inventoryReads: 0,
    httpSuccessRequired: "status=200, ok=true, redirected=false",
    allowedContentTypes: runner.POLICY.allowedContentTypes,
    requestHeadersPersisted: false,
    responseHeadersPersisted: false,
  });
  const verificationOrder = [
    "approval timestamp/bindings and complete package closure",
    "single-execution persistent guard",
    "one fixed raw-block HTTP GET with manual redirect rejection",
    "HTTP success and content-type sanity",
    "stream to memory under 16 MiB hard cap",
    `SHA-256(raw block bytes) equals ${runner.ACTIVE_DIGEST}`,
    "strict local DAG-PB/UnixFS decode",
    "persist verified raw block and sanitized result",
  ];
  const decodePolicy = canonical({ codec: "DAG-PB/UnixFS only", maxDecodeDepth: runner.POLICY.maxDecodeDepth, maxProtobufFields: runner.POLICY.maxProtobufFields, maxLinks: runner.POLICY.maxLinks, maxLinkCidBytes: runner.POLICY.maxLinkCidBytes, maxLinkNameBytes: runner.POLICY.maxLinkNameBytes, maxBlockSizes: runner.POLICY.maxBlockSizes, maxVarintBytes: runner.POLICY.maxVarintBytes, linksFollowed: 0, reportOnly: ["inlineMetadataBytesExist", "inlineMetadataBytes", "inlineMetadataSha256", "linkCount", "link CID-byte SHA-256 commitments"], inlineMetadataContentPersistedInResult: false });
  const persistence = canonical({ beforeHashMatch: { responseBodyBytes: 0, decodedFields: 0, rawBlock: false }, afterHashMatchAndDecode: { verifiedRawBlockPath: runner.RAW_BLOCK_REL, sanitizedResultPath: runner.RESULT_REL }, wrongHashRedirectOversizeTimeoutOrHttpFailure: { responseBodyPersisted: false, responseHeadersPersisted: false }, executionGuardPath: runner.LOCK_REL, executionGuardConsumesApprovalBeforeTransportAndSurvivesFailure: true });
  const fixtureIds = fixtures.fixtures.map((row) => row.id);
  const generatedAt = new Date().toISOString();
  const proposalCore = canonical({ schemaVersion: 1, generatedAt, name: NAME, agentId: AGENT, role: "reviewer", proposalStatus: STATUS, classification: CLASSIFICATION, predecessorBinding: predecessor, activeCid: { cid: runner.ACTIVE_CID, multihashHex: `1220${runner.ACTIVE_DIGEST}`, algorithm: "sha2-256", digestSha256: runner.ACTIVE_DIGEST }, runner: runnerHash, transport, approvalSchema, verificationOrder, decodePolicy, persistence, exactlyOneFutureExecution: true, fixturePlan: { count: fixtureIds.length, fixtureIds, allPassedOffline: true }, decisionRequested: DECISION, gates: { authorized: false, executed: false, network: false, publicRetrieval: false, rpc: false, inventory: false, recursiveRetrieval: false, linksFollowed: 0, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false } });
  const runId = `${NAME}-${digest(proposalCore)}-${runnerHash.sha256.slice(0, 16)}`;
  const proposal = canonical({ ...proposalCore, runId });
  write(PROPOSAL, `${JSON.stringify(proposal, null, 2)}\n`);
  const raw = canonical({ schemaVersion: 1, generatedAt, runId, agentId: AGENT, role: "reviewer", status: STATUS, proposalStatus: STATUS, classification: CLASSIFICATION, step4AggregateSha256: STEP4_AGGREGATE, activeCid: proposal.activeCid, proposal: hashFile(PROPOSAL), runner: runnerHash, mockFixtures: { count: fixtures.fixtureCount, passed: fixtures.fixturesPassed }, limits: { exactRequests: 1, maxResponseBytes: runner.POLICY.maxResponseBytes, timeoutMs: runner.POLICY.requestTimeoutMs, retries: 0, approvalStartWindowMs: runner.POLICY.approvalStartWindowMs, maxDecodeDepth: runner.POLICY.maxDecodeDepth, maxLinks: runner.POLICY.maxLinks }, activityScope: { offlineOnly: true, networkRequests: 0, httpRequests: 0, webRequests: 0, rpcCalls: 0, endpointInventoryReads: 0, publicRetrievalExecuted: false, rawBlockPersisted: false, fork: false, signedTransactions: 0, broadcasts: 0, secretFileReads: 0 }, decisionRequested: DECISION, routePositive: 0, executableNow: 0, signedActionJustified: false });
  write(RAW, `${JSON.stringify(raw, null, 2)}\n`);
  write(TESTS, `${JSON.stringify(fixtures, null, 2)}\n`);
  write(REPORT, `# 🟠 REVIEW REQUESTED — Across HyperEVM CCTP recovery Step 5\n\n**Status:** \`${STATUS}\`  \n**Classification:** \`${CLASSIFICATION}\`\n\nStep 5 is an offline-built, mock-validated proposal for exactly one future public raw-block request. No network, RPC, inventory, CID enumeration, recursive retrieval, link follow, decode of live bytes, or raw-block persistence occurred.\n\n## Immutable bindings\n\n- Approved Step 4 aggregate: \`${STEP4_AGGREGATE}\`\n- Active CID: \`${runner.ACTIVE_CID}\`\n- Required raw-block SHA-256: \`${runner.ACTIVE_DIGEST}\`\n- Runner SHA-256: \`${runnerHash.sha256}\`\n\n## Future execution caps\n\nOne fixed gateway GET; redirect mode \`manual\` with redirects rejected; exactly \`1\` request; \`${runner.POLICY.maxResponseBytes}\`-byte streamed hard cap; \`${runner.POLICY.requestTimeoutMs}\` ms timeout; \`0\` retries; approval start window \`${runner.POLICY.approvalStartWindowMs}\` ms. HTTP 200 and an allowlisted raw/binary content type are required. Raw bytes must hash to the bound digest before decode or raw-block persistence.\n\nOnly strict DAG-PB/UnixFS is decoded locally under depth \`${runner.POLICY.maxDecodeDepth}\`, link cap \`${runner.POLICY.maxLinks}\`, and protobuf bounds. The result reports inline-byte presence/size/commitment and link CID-byte commitments. Links are never fetched. Runtime outputs retain no gateway URL/query, request headers, or response headers.\n\n## Mock evidence\n\nFixtures: \`${fixtures.fixturesPassed}/${fixtures.fixtureCount}\` passed, including valid block, wrong hash, redirect, oversize stream, timeout, malformed DAG-PB, raw JSON, linked/no-follow, second-request prevention, stale/wrong approval, prerequisite-before-transport, and output leak.\n\n## Decision request\n\n${DECISION}\n`);
  const inbox = canonical({ findingId: NAME, runId, agentId: AGENT, role: "reviewer", status: STATUS, classification: CLASSIFICATION, routePositive: 0, executableNow: 0, signedActionJustified: false, summary: `Offline Step5 package mock-validates one future hash-before-decode raw-block request with ${fixtures.fixturesPassed}/${fixtures.fixtureCount} fixtures; no network was executed.`, artifacts: [PROPOSAL, RAW, TESTS, LEAK, MANIFEST, REPORT, SCANNER, RUNNER, TEST_SOURCE, VALIDATOR, HANDOFF], nextAction: DECISION });
  write(INBOX, `${JSON.stringify(inbox, null, 2)}\n`);
  write(HANDOFF, `# Across HyperEVM CCTP recovery Step 5 handoff\n\n- Status \`${STATUS}\`; no network/public retrieval executed.\n- Step 4 aggregate \`${STEP4_AGGREGATE}\`; CID \`${runner.ACTIVE_CID}\`; digest \`${runner.ACTIVE_DIGEST}\`.\n- Future caps: one request, ${runner.POLICY.maxResponseBytes} bytes, ${runner.POLICY.requestTimeoutMs} ms, zero retries, redirects rejected, 15-minute approval start window.\n- Strict DAG-PB/UnixFS local decode only; link count and CID-byte commitments only; links followed 0.\n- Mock fixtures ${fixtures.fixturesPassed}/${fixtures.fixtureCount}.\n- Decision: ${DECISION}\n`);
  const leak = leakScan([PROPOSAL, RAW, TESTS, REPORT, INBOX, HANDOFF]);
  if (!leak.passed) throw new Error("output-leak-scan-failed");
  write(LEAK, `${JSON.stringify(leak, null, 2)}\n`);
  const records = [SCANNER, RUNNER, TEST_SOURCE, VALIDATOR, PROPOSAL, RAW, TESTS, LEAK, REPORT, INBOX, HANDOFF].map(hashFile), aggregateSha256 = runner.aggregateRecords(records);
  const manifest = canonical({ schemaVersion: 1, generatedAt, runId, proposalStatus: STATUS, classification: CLASSIFICATION, aggregateSha256, records, activeCid: { cid: runner.ACTIVE_CID, digestSha256: runner.ACTIVE_DIGEST }, predecessorBinding: predecessor, approvalBinding: { requiredProposalRunId: runId, requiredPackageManifestAggregateSha256: aggregateSha256, requiredRunnerSha256: runnerHash.sha256, requiredCid: runner.ACTIVE_CID, requiredDigestSha256: runner.ACTIVE_DIGEST, requiredDecisionTimestamp: true, startWindowMs: runner.POLICY.approvalStartWindowMs, exactlyOneExecution: true }, caps: raw.limits, fixtureEvidence: { count: fixtures.fixtureCount, passed: fixtures.fixturesPassed, testsArtifact: hashFile(TESTS) }, leakScanPassed: true, claimAtBuild: claim, activityScope: raw.activityScope, decisionRequested: DECISION });
  write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, runId, status: STATUS, classification: CLASSIFICATION, step4AggregateSha256: STEP4_AGGREGATE, cid: runner.ACTIVE_CID, digestSha256: runner.ACTIVE_DIGEST, runnerSha256: runnerHash.sha256, fixtures: `${fixtures.fixturesPassed}/${fixtures.fixtureCount}`, exactRequests: 1, maxResponseBytes: runner.POLICY.maxResponseBytes, timeoutMs: runner.POLICY.requestTimeoutMs, retries: 0, approvalStartWindowMs: runner.POLICY.approvalStartWindowMs, records: records.length, aggregateSha256, networkRequests: 0, decisionRequested: DECISION })}\n`);
}

main().catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, category: String(error.message || error) })}\n`); process.exit(1); });
