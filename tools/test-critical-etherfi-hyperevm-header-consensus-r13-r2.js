#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-hyperevm-header-consensus-r13-r2";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const MATRIX = `reports/raw/fast/${NAME}-corrected-historical-matrix.json`;
const R13_RAW = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13.json";
const R13_MANIFEST = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-manifest.json";
const R13_MATRIX = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-corrected-historical-matrix.json";
const REVISION = "etherfi-hyperevm-header-consensus-r13-r2-reviewer-bounded";
const MATRIX_REVISION = "etherfi-hyperevm-historical-matrix-r13-r2-method-schema-candidate-expectations";
const CLASSIFICATION = "WATCH/PREFLIGHT-PASS/HYPEREVM-BLOCK1-NINE-FAMILY-SELECTED-HEADER-CANONICAL-FINGERPRINT-CONSENSUS/CORRECTED-MATRIX-CANDIDATE-EXPECTATIONS/R14-STATE-QUALIFICATION-REQUIRED/NO-BACKEND-INDEPENDENCE-CLAIM";
const QUALIFICATION = "Nine anonymous hostname-derived groups are header-consensus-qualified only; archive qualification requires R14 state-canary verification, and backend/operator independence is not established.";
const R14_STATUS = "APPROVED_FOR_READ_ONLY_R14_STATE_CANARY_VERIFICATION_ONLY";

const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const clone = (value) => JSON.parse(JSON.stringify(value));

function exactKeys(object, allowed) { assert.deepStrictEqual(Object.keys(object).sort(), [...allowed].sort(), "schema-fields-mismatch"); }
function address(value) { return typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value); }
function word(value) { return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value); }
function bytes(value) { return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/.test(value); }
function quantity(value) { return typeof value === "string" && /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/.test(value); }
function block(value) { return Number.isSafeInteger(value) && value >= 1; }

function validateRows(rows) {
  assert(Array.isArray(rows)); assert.strictEqual(rows.length, 8); const ids = new Set(); const byId = new Map(); const methods = new Set(["eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_call"]);
  for (const row of rows) {
    assert(row && typeof row === "object" && !Array.isArray(row)); assert(typeof row.id === "string" && /^[a-z0-9-]+$/.test(row.id) && !ids.has(row.id)); ids.add(row.id); byId.set(row.id, row); assert(methods.has(row.method)); assert(block(row.blockNumber)); assert.strictEqual(row.candidateExpectation, true); assert.strictEqual(row.r14VerificationRequired, true);
    if (row.method === "eth_getBalance") { exactKeys(row, ["id", "method", "blockNumber", "account", "expectedQuantity", "candidateExpectation", "r14VerificationRequired"]); assert(address(row.account)); assert(quantity(row.expectedQuantity)); }
    if (row.method === "eth_getCode") { const hasData = Object.hasOwn(row, "expectedData"); const hasPredicate = Object.hasOwn(row, "expectedPredicate"); assert.notStrictEqual(hasData, hasPredicate); exactKeys(row, hasData ? ["id", "method", "blockNumber", "contract", "expectedData", "candidateExpectation", "r14VerificationRequired"] : ["id", "method", "blockNumber", "contract", "expectedPredicate", "candidateExpectation", "r14VerificationRequired"]); assert(address(row.contract)); if (hasData) assert(bytes(row.expectedData)); if (hasPredicate) assert.strictEqual(row.expectedPredicate, "non-empty"); }
    if (row.method === "eth_getStorageAt") { exactKeys(row, ["id", "method", "blockNumber", "contract", "storageKey", "expectedWord", "candidateExpectation", "r14VerificationRequired"]); assert(address(row.contract)); assert(word(row.storageKey)); assert(word(row.expectedWord)); }
    if (row.method === "eth_call") { exactKeys(row, ["id", "method", "blockNumber", "contract", "function", "holder", "expectedWord", "mustMatchStorage", "storageReferenceId", "candidateExpectation", "r14VerificationRequired"]); assert(address(row.contract)); assert(address(row.holder)); assert.strictEqual(row.function, "balanceOf(address)"); assert(word(row.expectedWord)); assert.strictEqual(row.mustMatchStorage, true); assert.strictEqual(typeof row.storageReferenceId, "string"); }
  }
  assert.strictEqual(ids.size, 8); for (const row of rows.filter((item) => item.method === "eth_call")) { const reference = byId.get(row.storageReferenceId); assert(reference); assert.strictEqual(reference.method, "eth_getStorageAt"); assert.strictEqual(reference.blockNumber, row.blockNumber); assert.strictEqual(reference.contract, row.contract); assert.strictEqual(reference.expectedWord, row.expectedWord); }
  return true;
}

function validateMatrix(matrix) {
  exactKeys(matrix, ["schemaVersion", "revision", "generatedAt", "provenance", "block1SelectedHeader", "stateCanaries", "schemaValidation", "qualification", "matrixDigest"]); assert.strictEqual(matrix.schemaVersion, 2); assert.strictEqual(matrix.revision, MATRIX_REVISION); assert(Number.isFinite(Date.parse(matrix.generatedAt)));
  exactKeys(matrix.provenance, ["immediatePredecessorRunId", "immediatePredecessorMatrix", "sourceSpecificationStatus", "sourceMalformedHashRetained"]); exactKeys(matrix.provenance.immediatePredecessorMatrix, ["path", "bytes", "sha256"]); assert.strictEqual(matrix.provenance.immediatePredecessorMatrix.path, R13_MATRIX); assert.deepStrictEqual(matrix.provenance.immediatePredecessorMatrix, hashFile(R13_MATRIX)); assert.strictEqual(matrix.provenance.sourceSpecificationStatus, "matrix-spec-malformed-block1-hash-width"); assert.strictEqual(matrix.provenance.sourceMalformedHashRetained, false);
  exactKeys(matrix.block1SelectedHeader, ["blockNumber", "consensusDerivedBlockHash", "selectedHeaderCanonicalFingerprintDigest", "headerConsensusQualifiedFamilyCount", "minimumConsensusFamilies", "selectedFieldProfile", "completeDocumentedHyperEvmHeaderProfileEnforced", "individualCoreRootAndTimestampValuesRetainedByR13", "agreedCoreFieldsCommittedByFingerprintDigest", "blockHashRecomputed"]); const header = matrix.block1SelectedHeader; assert.strictEqual(header.blockNumber, 1); assert(word(header.consensusDerivedBlockHash)); assert(/^[0-9a-f]{64}$/.test(header.selectedHeaderCanonicalFingerprintDigest)); assert.strictEqual(header.headerConsensusQualifiedFamilyCount, 9); assert.strictEqual(header.minimumConsensusFamilies, 3); assert(Array.isArray(header.selectedFieldProfile)); assert.strictEqual(new Set(header.selectedFieldProfile).size, header.selectedFieldProfile.length); assert.strictEqual(header.completeDocumentedHyperEvmHeaderProfileEnforced, false); assert.strictEqual(header.individualCoreRootAndTimestampValuesRetainedByR13, false); assert.strictEqual(header.agreedCoreFieldsCommittedByFingerprintDigest, true); assert.strictEqual(header.blockHashRecomputed, false);
  validateRows(matrix.stateCanaries); exactKeys(matrix.schemaValidation, ["valid", "stateCanaryCount", "uniqueIdCount", "allowedMethodCount", "mustMatchStorageReferencesValid", "unknownFieldsRejected", "candidateExpectationsOnly"]); assert.deepStrictEqual(matrix.schemaValidation, { valid: true, stateCanaryCount: 8, uniqueIdCount: 8, allowedMethodCount: 4, mustMatchStorageReferencesValid: true, unknownFieldsRejected: true, candidateExpectationsOnly: true }); exactKeys(matrix.qualification, ["headerConsensusQualified", "archiveQualified", "stateCanariesVerified", "r14VerificationRequired", "candidateExpectationsOnly"]); assert.deepStrictEqual(matrix.qualification, { headerConsensusQualified: true, archiveQualified: false, stateCanariesVerified: false, r14VerificationRequired: true, candidateExpectationsOnly: true }); assert(/^[0-9a-f]{64}$/.test(matrix.matrixDigest)); const digestInput = { ...matrix }; delete digestInput.matrixDigest; assert.strictEqual(digest(digestInput), matrix.matrixDigest); return true;
}

function rejectsFixture(matrix, mutate, label) { const fixture = clone(matrix); mutate(fixture); assert.throws(() => validateMatrix(fixture), undefined, label); }
function negativeFixtures(matrix) {
  const tests = [
    ["duplicate-id", (m) => { m.stateCanaries[1].id = m.stateCanaries[0].id; }],
    ["unknown-method", (m) => { m.stateCanaries[0].method = "eth_unknown"; }],
    ["bad-address", (m) => { m.stateCanaries.find((r) => r.method === "eth_getBalance").account = "0x01"; }],
    ["bad-storage-key", (m) => { m.stateCanaries.find((r) => r.method === "eth_getStorageAt").storageKey = "0x00"; }],
    ["bad-word", (m) => { m.stateCanaries.find((r) => r.method === "eth_call").expectedWord = "0x01"; }],
    ["noncanonical-quantity", (m) => { m.stateCanaries.find((r) => r.method === "eth_getBalance").expectedQuantity = "0x00"; }],
    ["bad-predicate", (m) => { m.stateCanaries.find((r) => Object.hasOwn(r, "expectedPredicate")).expectedPredicate = "anything"; }],
    ["unknown-field", (m) => { m.stateCanaries[0].unexpected = true; }],
    ["missing-required", (m) => { delete m.stateCanaries.find((r) => r.method === "eth_getStorageAt").storageKey; }],
    ["bad-storage-reference", (m) => { m.stateCanaries.find((r) => r.method === "eth_call").storageReferenceId = "missing"; }],
    ["bad-block", (m) => { m.stateCanaries[0].blockNumber = 0; }],
    ["unknown-envelope-field", (m) => { m.unexpected = true; }]
  ];
  for (const [label, mutate] of tests) rejectsFixture(matrix, mutate, label); return tests.length;
}

function scopedLeakCheck(text, source = false) { assert(!/(?:https?|wss?):\/\//i.test(text), "endpoint scheme leak"); if (!source) { const candidates = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || []; assert(!candidates.some((value) => !/\.(?:json|js|md|txt|sol)$/i.test(value)), "endpoint hostname leak"); } assert(!/(?:authorization|x-api-key|api-key|apikey|api_key|bearer)\s*[:=]\s*[^\s,}\]]+/i.test(text), "secret material leak"); }

function main() {
  const required = [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, MATRIX, R13_RAW, R13_MANIFEST, R13_MATRIX]; for (const rel of required) assert(fs.existsSync(abs(rel)), `missing ${rel}`);
  const scannerSource = read(SCANNER); assert(!scannerSource.includes("parseMatrix")); assert(!scannerSource.includes("requalification-r12")); assert(!scannerSource.includes("hyperevm_archive_endpoints.md")); for (const operation of [".padStart(", ".substring(", ".substr(", ".slice("]) assert(!scannerSource.includes(operation), `forbidden hash-normalization/substring operation ${operation}`); assert(scannerSource.includes("function parseR13SourceStrict"));
  const raw = json(RAW); const manifest = json(MANIFEST); const matrix = json(MATRIX); const predecessor = json(R13_RAW); const predecessorManifest = json(R13_MANIFEST); assert.strictEqual(raw.revision, REVISION); assert.strictEqual(raw.classification, CLASSIFICATION); assert.strictEqual(raw.providerFamilyQualification, QUALIFICATION); assert.strictEqual(raw.routePositive, 0); assert.strictEqual(raw.executableNow, 0); assert.strictEqual(raw.signedActionJustified, false); assert.strictEqual(raw.fork, false); assert.strictEqual(raw.backendOperatorIndependenceEstablished, false); assert.strictEqual(raw.backendOperatorIndependenceClaimed, false);
  assert.strictEqual(raw.sourceParserValidation.implementation, "R13-only-strict-structured-source-parser"); assert.strictEqual(raw.sourceParserValidation.r12ParserImported, false); assert.strictEqual(raw.sourceParserValidation.malformedHashCategory, "matrix-spec-malformed-block1-hash-width"); assert.strictEqual(raw.sourceParserValidation.malformedHashRejectedBeforeStateCanaryParsing, true); assert.strictEqual(raw.sourceParserValidation.stateParserCallsBeforeRejection, 0); assert.strictEqual(raw.sourceParserValidation.partialHashMatching, false); assert.strictEqual(raw.sourceParserValidation.hashPadding, false); assert.strictEqual(raw.sourceParserValidation.hashTruncation, false);
  assert.strictEqual(raw.selectedHeaderConsensus.terminology, "selected-header canonical fingerprint consensus"); assert.strictEqual(raw.selectedHeaderConsensus.headerConsensusQualifiedFamilyCount, 9); assert.strictEqual(raw.selectedHeaderConsensus.archiveQualifiedFamilyCount, 0); assert.strictEqual(raw.selectedHeaderConsensus.fingerprintGroupCount, 1); assert.strictEqual(raw.selectedHeaderConsensus.exactFingerprintAgreement, true); assert.strictEqual(raw.selectedHeaderConsensus.consensusDerivedBlockHash, predecessor.consensus.correctedBlockHash); assert.strictEqual(raw.selectedHeaderConsensus.selectedHeaderCanonicalFingerprintDigest, predecessor.consensus.fullHeaderCanonicalDigest); assert.strictEqual(raw.selectedHeaderConsensus.blockHashRecomputed, false); assert.strictEqual(raw.selectedHeaderConsensus.completeDocumentedHyperEvmHeaderProfileEnforced, false);
  validateMatrix(matrix); const negativeFixtureCount = negativeFixtures(matrix); assert.strictEqual(negativeFixtureCount, 12); assert.strictEqual(raw.correctedMatrix.path, MATRIX); assert.strictEqual(raw.correctedMatrix.sha256, hashFile(MATRIX).sha256); assert.strictEqual(raw.correctedMatrix.matrixDigest, matrix.matrixDigest); assert.strictEqual(raw.correctedMatrix.candidateExpectationsOnly, true); assert.strictEqual(raw.correctedMatrix.stateCanariesVerified, false); assert.strictEqual(raw.schemaValidation.negativeFixturesRequiredByValidator, true);
  assert.strictEqual(raw.immutablePredecessorR13.runId, predecessor.runId); assert.deepStrictEqual(raw.immutablePredecessorR13.raw, hashFile(R13_RAW)); assert.deepStrictEqual(raw.immutablePredecessorR13.manifest, hashFile(R13_MANIFEST)); assert.deepStrictEqual(raw.immutablePredecessorR13.correctedMatrix, hashFile(R13_MATRIX)); assert.strictEqual(raw.immutablePredecessorR13.manifestAggregateSha256, predecessorManifest.aggregateSha256);
  assert.strictEqual(raw.r14Approval.status, R14_STATUS); assert.strictEqual(raw.r14Approval.readOnlyStateCanaryTestingApproved, true); assert.strictEqual(raw.r14Approval.archiveQualificationApproved, false); assert.strictEqual(raw.r14Approval.economicsApproved, false); assert.strictEqual(raw.r14Approval.promotionApproved, false); assert.strictEqual(raw.leakGate.scope, "endpoint-and-secret-material-in-r13-r2-package"); assert.strictEqual(raw.leakGate.scopedNotAbsolute, true); assert.strictEqual(raw.leakGate.absoluteSecrecyClaim, false); assert.deepStrictEqual(raw.safety, { offline: true, endpointReads: false, inventoryReads: false, sourceMarkdownReads: false, r12ParserImported: false, behavioralRoutes: false, anchors: false, economics: false, transactions: false, forkCreated: false, signing: false, mutation: false });
  const report = read(REPORT); assert(report.includes("selected-header canonical fingerprint consensus")); assert(report.includes("candidate state expectations")); assert(report.includes("not an absolute secrecy claim")); assert(!/full-header consensus/i.test(report)); assert(!/archive-qualified/i.test(report));
  assert.strictEqual(manifest.revision, REVISION); assert.strictEqual(manifest.runId, raw.runId); assert.strictEqual(manifest.classification, CLASSIFICATION); assert.strictEqual(manifest.providerFamilyQualification, QUALIFICATION); const expectedRecords = [SCANNER, VALIDATOR, RAW, REPORT, MATRIX, R13_RAW, R13_MANIFEST, R13_MATRIX].map(hashFile); assert.deepStrictEqual(manifest.records, expectedRecords); const expectedAggregate = sha(Buffer.from(expectedRecords.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))); assert.strictEqual(manifest.aggregateSha256, expectedAggregate);
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, MATRIX]) scopedLeakCheck(read(rel), rel === SCANNER || rel === VALIDATOR);
  process.stdout.write(JSON.stringify({ status: "PASS", runId: raw.runId, classification: raw.classification, headerConsensusQualifiedFamilies: 9, archiveQualifiedFamilies: 0, correctedMatrix: raw.correctedMatrix, negativeFixtureCount, scopedEndpointSecretLeakGate: "PASS", manifestAggregateSha256: manifest.aggregateSha256, r14Approval: raw.r14Approval }) + "\n");
}

main();
