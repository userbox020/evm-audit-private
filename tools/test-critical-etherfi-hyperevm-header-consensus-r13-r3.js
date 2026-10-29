#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-hyperevm-header-consensus-r13-r3";
const REVISION = "etherfi-hyperevm-header-consensus-r13-r3-coordination-complete";
const CLASSIFICATION = "WATCH/PREFLIGHT-PASS/HYPEREVM-BLOCK1-NINE-FAMILY-SELECTED-HEADER-CANONICAL-FINGERPRINT-CONSENSUS/CORRECTED-MATRIX-CANDIDATE-EXPECTATIONS/R14-STATE-QUALIFICATION-REQUIRED/NO-BACKEND-INDEPENDENCE-CLAIM";
const QUALIFICATION = "Nine anonymous hostname-derived groups are header-consensus-qualified only; archive qualification requires R14 state-canary verification, and backend/operator independence is not established.";
const R14_STATUS = "APPROVED_FOR_READ_ONLY_R14_STATE_CANARY_VERIFICATION_ONLY";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-23-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-23-${NAME}-handoff.md`;
const R2_SCANNER = "tools/scan-critical-etherfi-hyperevm-header-consensus-r13-r2.js";
const R2_VALIDATOR = "tools/test-critical-etherfi-hyperevm-header-consensus-r13-r2.js";
const R2_RAW = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-r2.json";
const R2_MANIFEST = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-r2-manifest.json";
const R2_REPORT = "reports/critical-etherfi-hyperevm-header-consensus-r13-r2.md";
const R2_MATRIX = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-r2-corrected-historical-matrix.json";
const OWNED = [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF];
const PREDECESSOR = [R2_SCANNER, R2_VALIDATOR, R2_RAW, R2_MANIFEST, R2_REPORT, R2_MATRIX];
const RECORDS = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R2_MATRIX, R2_SCANNER, R2_VALIDATOR, R2_RAW, R2_MANIFEST, R2_REPORT];
const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };

function assertBoundaries(value) {
  assert.strictEqual(value.classification, CLASSIFICATION); assert.strictEqual(value.providerFamilyQualification, QUALIFICATION); assert.strictEqual(value.backendOperatorIndependenceEstablished, false); assert.strictEqual(value.backendOperatorIndependenceClaimed, false);
  assert.deepStrictEqual(value.gates, { archiveQualificationClosed: true, economicsClosed: true, executableNow: 0, fork: false, promotionClosed: true, routePositive: 0, signedActionJustified: false });
  assert.strictEqual(value.candidateOnlyMatrix.path, R2_MATRIX); assert.strictEqual(value.candidateOnlyMatrix.schemaValidated, true); assert.strictEqual(value.candidateOnlyMatrix.stateExpectationCount, 8); assert.strictEqual(value.candidateOnlyMatrix.candidateExpectationsOnly, true); assert.strictEqual(value.candidateOnlyMatrix.stateCanariesVerified, false); assert(/^[0-9a-f]{64}$/.test(value.candidateOnlyMatrix.sha256)); assert(/^[0-9a-f]{64}$/.test(value.candidateOnlyMatrix.matrixDigest));
  assert.deepStrictEqual(value.r14Approval, { archiveQualificationApproved: false, economicsApproved: false, promotionApproved: false, readOnlyStateCanaryTestingApproved: true, status: R14_STATUS });
}

function leakCheck(text, source = false) { assert(!/(?:https?|wss?):\/\//i.test(text)); if (!source) { const candidates = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || []; assert(!candidates.some((value) => !/\.(?:json|js|md|txt|sol)$/i.test(value))); } assert(!/(?:authorization|x-api-key|api-key|apikey|api_key|bearer)\s*[:=]\s*[^\s,}\]]+/i.test(text)); }

function main() {
  for (const rel of [...OWNED, ...PREDECESSOR]) assert(fs.existsSync(abs(rel)), `missing ${rel}`);
  const raw = json(RAW); const manifest = json(MANIFEST); const inbox = json(INBOX); const r2Raw = json(R2_RAW); const r2Manifest = json(R2_MANIFEST); const r2Matrix = json(R2_MATRIX); const handoff = read(HANDOFF); const report = read(REPORT);
  assert.strictEqual(raw.revision, REVISION); assert.strictEqual(raw.coordinationStatus, "COMPLETE"); assertBoundaries(raw); assert.strictEqual(raw.selectedHeaderConsensus.terminology, "selected-header canonical fingerprint consensus"); assert.strictEqual(raw.selectedHeaderConsensus.headerConsensusQualifiedFamilyCount, 9); assert.strictEqual(raw.selectedHeaderConsensus.archiveQualifiedFamilyCount, 0); assert.strictEqual(raw.selectedHeaderConsensus.blockHashRecomputed, false); assert.strictEqual(raw.selectedHeaderConsensus.completeDocumentedHyperEvmHeaderProfileEnforced, false);
  const expectedPredecessor = { artifacts: PREDECESSOR.map(hashFile), manifestAggregateSha256: r2Manifest.aggregateSha256, runId: r2Raw.runId, status: "IMMUTABLE-PREDECESSOR/R13-R2-TECHNICAL-PACKAGE" }; assert.deepStrictEqual(raw.predecessorBinding, expectedPredecessor); assert.strictEqual(raw.candidateOnlyMatrix.sha256, hashFile(R2_MATRIX).sha256); assert.strictEqual(raw.candidateOnlyMatrix.matrixDigest, r2Matrix.matrixDigest);
  assert.deepStrictEqual(raw.scannerOwnership.ownedPackagePaths, OWNED); assert.deepStrictEqual(raw.scannerOwnership.ownedWritableArtifactPaths, [RAW, MANIFEST, REPORT, INBOX, HANDOFF]); assert.deepStrictEqual(raw.scannerOwnership.readOnlyHashBoundPredecessorPaths, PREDECESSOR); assert.deepStrictEqual(raw.scannerOwnership.manifestRecordPaths, RECORDS); assert.strictEqual(raw.scannerOwnership.predecessorArtifactsMayBeOverwritten, false);
  assert.deepStrictEqual(raw.safety, { coordinatorCodeOrStateFilesEdited: false, economics: false, endpointReads: false, forkCreated: false, inventoryReads: false, mutation: false, offline: true, predecessorArtifactsModified: false, requestedInboxAndHandoffCreated: true, signing: false, sourceMarkdownReads: false, transactions: false }); assert.deepStrictEqual(raw.r14GovernanceReadiness, { archiveQualificationReady: false, coordinationArtifactsComplete: true, economicsReady: false, promotionReady: false, status: "READY_FOR_NARROW_READ_ONLY_R14_AUTHORIZATION", technicalEvidenceRequalified: false });
  assert.strictEqual(inbox.findingId, NAME); assert.strictEqual(inbox.revision, REVISION); assert.strictEqual(inbox.runId, raw.runId); assert.strictEqual(inbox.agentId, "critical-etherfi-hyper-header-r13r3-20260723"); assert.strictEqual(inbox.role, "critical-research"); assert.strictEqual(inbox.status, CLASSIFICATION); assert.strictEqual(inbox.coordinationStatus, "COMPLETE"); assertBoundaries(inbox); assert.deepStrictEqual(inbox.predecessorBinding, expectedPredecessor); assert.deepStrictEqual(inbox.artifacts, RECORDS); assert.deepStrictEqual(inbox.r14GovernanceReadiness, raw.r14GovernanceReadiness);
  for (const expected of [raw.runId, CLASSIFICATION, QUALIFICATION, R14_STATUS, R2_MATRIX, raw.candidateOnlyMatrix.sha256, r2Manifest.aggregateSha256, "READY_FOR_NARROW_READ_ONLY_R14_AUTHORIZATION", "state canaries unverified", "not an absolute secrecy claim"]) assert(handoff.includes(expected), `handoff missing ${expected}`);
  for (const expected of [raw.runId, CLASSIFICATION, QUALIFICATION, R14_STATUS, "candidate expectations only", "zero are archive-qualified", "not an absolute secrecy claim"]) assert(report.includes(expected), `report missing ${expected}`);
  assert.strictEqual(manifest.revision, REVISION); assert.strictEqual(manifest.runId, raw.runId); assert.strictEqual(manifest.coordinationStatus, "COMPLETE"); assertBoundaries(manifest); assert.deepStrictEqual(manifest.predecessorBinding, expectedPredecessor); assert.deepStrictEqual(manifest.scannerOwnership, raw.scannerOwnership); assert.deepStrictEqual(manifest.r14GovernanceReadiness, raw.r14GovernanceReadiness); const records = RECORDS.map(hashFile); assert.deepStrictEqual(manifest.records, records); const aggregate = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))); assert.strictEqual(manifest.aggregateSha256, aggregate);
  for (const rel of OWNED) leakCheck(read(rel), rel === SCANNER || rel === VALIDATOR);
  const scannerSource = read(SCANNER); assert(!scannerSource.includes("hyperevm_archive_endpoints.md")); assert(!scannerSource.includes("rpc_endpoints.txt")); assert(!scannerSource.includes("graphql_endpoints.txt"));
  process.stdout.write(JSON.stringify({ status: "PASS", runId: raw.runId, coordinationStatus: raw.coordinationStatus, manifestAggregateSha256: manifest.aggregateSha256, recordCount: manifest.records.length, predecessorArtifactCount: expectedPredecessor.artifacts.length, inbox: INBOX, handoff: HANDOFF, correctedMatrix: raw.candidateOnlyMatrix, r14GovernanceReadiness: raw.r14GovernanceReadiness, r14Approval: raw.r14Approval }) + "\n");
}

main();
