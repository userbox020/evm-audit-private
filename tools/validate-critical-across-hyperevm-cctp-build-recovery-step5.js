#!/usr/bin/env node
"use strict";

const assert = require("assert");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./run-critical-across-hyperevm-cctp-build-recovery-step5.js");

const ROOT = path.resolve(__dirname, ".."), NAME = runner.NAME;
const PROPOSAL = `reports/raw/fast/${NAME}-proposal.json`, RAW = `reports/raw/fast/${NAME}.json`, TESTS = `reports/raw/fast/${NAME}-tests.json`, LEAK = `reports/raw/fast/${NAME}-leak-scan.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`, SCANNER = `tools/scan-${NAME}.js`, RUNNER = `tools/run-${NAME}.js`, TEST_SOURCE = `tools/test-${NAME}.js`, VALIDATOR = `tools/validate-${NAME}.js`, INBOX = `coordination/inbox/review-${NAME}-2026-07-25.json`, HANDOFF = `coordination/handoffs/2026-07-25-${NAME}-handoff.md`;
const STEP4_MANIFEST = "reports/raw/fast/critical-across-hyperevm-cctp-build-recovery-step4-manifest.json";
const STATUS = "REVIEW_REQUESTED/NOT_AUTHORIZED/NOT_EXECUTED";
const abs = (rel) => path.join(ROOT, rel), read = (rel) => fs.readFileSync(abs(rel)), json = (rel) => JSON.parse(read(rel).toString("utf8")), sha = (value) => crypto.createHash("sha256").update(value).digest("hex"), hashFile = (rel) => { const body = read(rel); return { path: rel, bytes: body.length, sha256: sha(body) }; };

function main() {
  const checks = [];
  function check(value, label) { checks.push(label); assert(value, label); }
  for (const rel of [PROPOSAL, RAW, TESTS, LEAK, MANIFEST, REPORT, SCANNER, RUNNER, TEST_SOURCE, VALIDATOR, INBOX, HANDOFF, STEP4_MANIFEST]) check(fs.existsSync(abs(rel)), `exists:${rel}`);
  const proposal = json(PROPOSAL), raw = json(RAW), tests = json(TESTS), leak = json(LEAK), manifest = json(MANIFEST), inbox = json(INBOX), step4 = json(STEP4_MANIFEST), runnerText = read(RUNNER).toString("utf8"), report = read(REPORT).toString("utf8");
  check(proposal.proposalStatus === STATUS && raw.status === STATUS && raw.proposalStatus === STATUS && manifest.proposalStatus === STATUS, "status");
  check(proposal.runId === raw.runId && raw.runId === manifest.runId && inbox.runId === raw.runId, "run-id-continuity");
  check(proposal.classification === raw.classification && raw.classification === manifest.classification, "classification-continuity");
  check(step4.aggregateSha256 === runner.STEP4_AGGREGATE && manifest.predecessorBinding.step4AggregateSha256 === runner.STEP4_AGGREGATE, "step4-approved-aggregate");
  const step4Records = step4.records.map((record) => { const actual = hashFile(record.path); check(actual.bytes === record.bytes && actual.sha256 === record.sha256, `step4-record:${record.path}`); return actual; });
  check(runner.aggregateRecords(step4Records) === runner.STEP4_AGGREGATE, "step4-record-aggregate");
  check(proposal.activeCid.cid === runner.ACTIVE_CID && proposal.activeCid.digestSha256 === runner.ACTIVE_DIGEST && manifest.activeCid.cid === runner.ACTIVE_CID && manifest.activeCid.digestSha256 === runner.ACTIVE_DIGEST, "active-cid-digest");
  check(proposal.transport.exactRequestCap === 1 && raw.limits.exactRequests === 1 && manifest.caps.exactRequests === 1, "one-request-cap");
  check(proposal.transport.streamedResponseHardCapBytes === 16 * 1024 * 1024 && raw.limits.maxResponseBytes === 16 * 1024 * 1024, "sixteen-mib-cap");
  check(proposal.transport.timeoutMs === 20_000 && raw.limits.timeoutMs === 20_000, "timeout-cap");
  check(proposal.transport.retries === 0 && raw.limits.retries === 0, "no-retries");
  check(proposal.transport.redirectMode === "manual" && proposal.transport.redirectsRejected === true, "redirect-policy");
  check(proposal.transport.method === "GET" && proposal.transport.fixedPublicGateway === true && proposal.transport.fixedRawBlockPathForActiveCid === true, "fixed-gateway-get");
  check(proposal.transport.cidEnumeration === false && proposal.transport.recursiveRetrieval === false && proposal.transport.rpcCalls === 0 && proposal.transport.inventoryReads === 0, "forbidden-retrievals");
  check(proposal.transport.requestHeadersPersisted === false && proposal.transport.responseHeadersPersisted === false && proposal.transport.gatewayQueryPersisted === false, "header-query-sanitization");
  check(proposal.approvalSchema.startWindowMs === 900_000 && manifest.approvalBinding.startWindowMs === 900_000, "approval-window");
  check(proposal.approvalSchema.requiredFields.runnerSha256 === hashFile(RUNNER).sha256 && manifest.approvalBinding.requiredRunnerSha256 === hashFile(RUNNER).sha256, "runner-approval-binding");
  check(manifest.approvalBinding.requiredPackageManifestAggregateSha256 === manifest.aggregateSha256 && manifest.approvalBinding.requiredProposalRunId === manifest.runId && manifest.approvalBinding.requiredCid === runner.ACTIVE_CID && manifest.approvalBinding.requiredDigestSha256 === runner.ACTIVE_DIGEST && manifest.approvalBinding.exactlyOneExecution === true, "complete-approval-binding");
  check(proposal.verificationOrder.findIndex((value) => value.startsWith("SHA-256")) < proposal.verificationOrder.findIndex((value) => value.startsWith("strict local")), "hash-before-decode-plan");
  check(proposal.verificationOrder.findIndex((value) => value.startsWith("SHA-256")) < proposal.verificationOrder.findIndex((value) => value.startsWith("persist verified")), "hash-before-persist-plan");
  check(proposal.persistence.beforeHashMatch.responseBodyBytes === 0 && proposal.persistence.beforeHashMatch.decodedFields === 0 && proposal.persistence.beforeHashMatch.rawBlock === false, "prehash-no-persist-decode");
  check(proposal.decodePolicy.codec === "DAG-PB/UnixFS only" && proposal.decodePolicy.maxDecodeDepth === 2 && proposal.decodePolicy.maxLinks === 1024 && proposal.decodePolicy.linksFollowed === 0, "decode-bounds");
  check(proposal.decodePolicy.inlineMetadataContentPersistedInResult === false && proposal.decodePolicy.reportOnly.includes("link CID-byte SHA-256 commitments"), "decode-output-commitments");
  check(tests.passed === true && tests.fixtureCount === 13 && tests.fixturesPassed === 13 && tests.networkRequests === 0 && tests.publicRetrievalExecuted === false, "fixtures-summary");
  for (const id of ["valid-raw-block", "wrong-hash", "redirect-rejected", "oversize-stream", "timeout", "malformed-dag-pb", "raw-json-not-dag", "linked-unixfs-no-follow", "second-request-prevention", "stale-approval", "wrong-approval-binding", "prerequisite-before-transport", "output-leak"]) check(tests.fixtures.some((row) => row.id === id && row.passed), `fixture:${id}`);
  check(leak.passed === true && leak.findingCount === 0 && leak.gatewayQueryPersisted === false && leak.responseHeadersPersisted === false, "leak-scan");
  check(raw.activityScope.offlineOnly === true && raw.activityScope.networkRequests === 0 && raw.activityScope.httpRequests === 0 && raw.activityScope.webRequests === 0 && raw.activityScope.rpcCalls === 0 && raw.activityScope.endpointInventoryReads === 0 && raw.activityScope.publicRetrievalExecuted === false && raw.activityScope.rawBlockPersisted === false, "not-executed");
  check(proposal.gates.authorized === false && proposal.gates.executed === false && proposal.gates.network === false && proposal.gates.linksFollowed === 0, "gates-closed");
  check(!fs.existsSync(abs(runner.LOCK_REL)) && !fs.existsSync(abs(runner.RESULT_REL)) && !fs.existsSync(abs(runner.RAW_BLOCK_REL)) && !fs.existsSync(abs(runner.APPROVAL_REL)), "no-execution-artifacts");
  const records = manifest.records.map((record) => { const actual = hashFile(record.path); check(actual.bytes === record.bytes && actual.sha256 === record.sha256, `record:${record.path}`); return actual; });
  check(runner.aggregateRecords(records) === manifest.aggregateSha256, "package-aggregate");
  check(manifest.records.some((row) => row.path === RUNNER) && manifest.records.some((row) => row.path === TEST_SOURCE) && manifest.records.some((row) => row.path === VALIDATOR), "runner-tests-validator-bound");
  check((runnerText.match(/transport\.request\(/g) || []).length === 1, "single-transport-dispatch-site");
  check(runnerText.includes('redirect: "manual"') && runnerText.includes('method: "GET"'), "runner-http-controls");
  check(runnerText.indexOf("verifyPackage)(") < runnerText.indexOf("guard.acquire") && runnerText.indexOf("guard.acquire") < runnerText.indexOf("const verified = await fetchVerifiedRawBlock"), "runner-preflight-before-transport");
  check(runnerText.indexOf("observedDigest !== expectedDigest") < runnerText.indexOf("decodeDagPbUnixFs(verified.block)"), "runner-hash-before-decode");
  check(runnerText.indexOf("decodeDagPbUnixFs(verified.block)") < runnerText.indexOf("fs.writeFileSync(rawPath, verified.block"), "runner-decode-before-raw-persist");
  check(!/rpc_endpoints\.txt|graphql_endpoints\.txt|\.env\b/.test(runnerText), "runner-no-secret-inventory");
  const dry = JSON.parse(cp.execFileSync(process.execPath, [abs(RUNNER)], { cwd: ROOT, encoding: "utf8" }).trim());
  check(dry.status === STATUS && dry.networkInvoked === false && dry.requestCount === 0 && dry.approvalRequired === true, "runner-default-offline");
  check(report.includes(STATUS) && report.includes("13/13") && report.includes("Decision request"), "report");
  check(inbox.status === STATUS && inbox.routePositive === 0 && inbox.executableNow === 0 && inbox.signedActionJustified === false, "inbox");
  process.stdout.write(`${JSON.stringify({ ok: true, checksPassed: checks.length, checksTotal: checks.length, runId: manifest.runId, status: STATUS, fixtures: `${tests.fixturesPassed}/${tests.fixtureCount}`, runnerSha256: hashFile(RUNNER).sha256, manifestSha256: hashFile(MANIFEST).sha256, aggregateSha256: manifest.aggregateSha256, exactRequests: 1, maxResponseBytes: raw.limits.maxResponseBytes, timeoutMs: raw.limits.timeoutMs, retries: 0, approvalStartWindowMs: raw.limits.approvalStartWindowMs, networkRequests: 0, decisionRequested: raw.decisionRequested })}\n`);
}

try { main(); } catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, category: String(error.message || error) })}\n`); process.exit(1); }
