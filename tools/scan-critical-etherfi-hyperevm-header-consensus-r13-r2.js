#!/usr/bin/env node
"use strict";

// Offline reviewer correction over immutable R13 artifacts. No endpoint,
// inventory, or source-markdown read occurs in this tool.

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
const CORRECTED_MATRIX = `reports/raw/fast/${NAME}-corrected-historical-matrix.json`;
const R13_RAW = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13.json";
const R13_MANIFEST = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-manifest.json";
const R13_MATRIX = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-corrected-historical-matrix.json";
const REVISION = "etherfi-hyperevm-header-consensus-r13-r2-reviewer-bounded";
const MATRIX_REVISION = "etherfi-hyperevm-historical-matrix-r13-r2-method-schema-candidate-expectations";
const AGENT = "critical-etherfi-hyper-header-r13r2-20260723";
const CLASSIFICATION = "WATCH/PREFLIGHT-PASS/HYPEREVM-BLOCK1-NINE-FAMILY-SELECTED-HEADER-CANONICAL-FINGERPRINT-CONSENSUS/CORRECTED-MATRIX-CANDIDATE-EXPECTATIONS/R14-STATE-QUALIFICATION-REQUIRED/NO-BACKEND-INDEPENDENCE-CLAIM";
const QUALIFICATION = "Nine anonymous hostname-derived groups are header-consensus-qualified only; archive qualification requires R14 state-canary verification, and backend/operator independence is not established.";
const R14_STATUS = "APPROVED_FOR_READ_ONLY_R14_STATE_CANARY_VERIFICATION_ONLY";

const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };

function writeOwned(rel, body) { if (![RAW, MANIFEST, REPORT, CORRECTED_MATRIX].includes(rel)) throw new Error("write-refused"); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, "utf8"); }
function exactKeys(object, allowed) { const actual = Object.keys(object).sort(); const expected = [...allowed].sort(); if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("schema-fields-mismatch"); }
function address(value) { return typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value); }
function word(value) { return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value); }
function bytes(value) { return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/.test(value); }
function quantity(value) { return typeof value === "string" && /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/.test(value); }
function block(value) { return Number.isSafeInteger(value) && value >= 1; }

function validateStateCanaries(rows) {
  if (!Array.isArray(rows) || rows.length !== 8) throw new Error("state-canary-count"); const ids = new Set(); const byId = new Map(); const allowedMethods = new Set(["eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_call"]);
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("state-canary-object"); if (typeof row.id !== "string" || !/^[a-z0-9-]+$/.test(row.id) || ids.has(row.id)) throw new Error("state-canary-id"); ids.add(row.id); byId.set(row.id, row); if (!allowedMethods.has(row.method) || !block(row.blockNumber)) throw new Error("state-canary-method-or-block");
    if (row.method === "eth_getBalance") { exactKeys(row, ["id", "method", "blockNumber", "account", "expectedQuantity", "candidateExpectation", "r14VerificationRequired"]); if (!address(row.account) || !quantity(row.expectedQuantity)) throw new Error("balance-schema"); }
    if (row.method === "eth_getCode") { const hasData = Object.hasOwn(row, "expectedData"); const hasPredicate = Object.hasOwn(row, "expectedPredicate"); if (hasData === hasPredicate) throw new Error("code-expectation-shape"); exactKeys(row, hasData ? ["id", "method", "blockNumber", "contract", "expectedData", "candidateExpectation", "r14VerificationRequired"] : ["id", "method", "blockNumber", "contract", "expectedPredicate", "candidateExpectation", "r14VerificationRequired"]); if (!address(row.contract) || hasData && !bytes(row.expectedData) || hasPredicate && row.expectedPredicate !== "non-empty") throw new Error("code-schema"); }
    if (row.method === "eth_getStorageAt") { exactKeys(row, ["id", "method", "blockNumber", "contract", "storageKey", "expectedWord", "candidateExpectation", "r14VerificationRequired"]); if (!address(row.contract) || !word(row.storageKey) || !word(row.expectedWord)) throw new Error("storage-schema"); }
    if (row.method === "eth_call") { exactKeys(row, ["id", "method", "blockNumber", "contract", "function", "holder", "expectedWord", "mustMatchStorage", "storageReferenceId", "candidateExpectation", "r14VerificationRequired"]); if (!address(row.contract) || !address(row.holder) || row.function !== "balanceOf(address)" || !word(row.expectedWord) || row.mustMatchStorage !== true || typeof row.storageReferenceId !== "string") throw new Error("call-schema"); }
    if (row.candidateExpectation !== true || row.r14VerificationRequired !== true) throw new Error("candidate-expectation-flags");
  }
  for (const row of rows.filter((item) => item.method === "eth_call")) { const reference = byId.get(row.storageReferenceId); if (!reference || reference.method !== "eth_getStorageAt" || reference.blockNumber !== row.blockNumber || reference.contract !== row.contract || reference.expectedWord !== row.expectedWord) throw new Error("must-match-storage-reference"); }
  return { valid: true, stateCanaryCount: rows.length, uniqueIdCount: ids.size, allowedMethodCount: allowedMethods.size, mustMatchStorageReferencesValid: true, unknownFieldsRejected: true, candidateExpectationsOnly: true };
}

function validateCorrectedMatrix(matrix) {
  exactKeys(matrix, ["schemaVersion", "revision", "generatedAt", "provenance", "block1SelectedHeader", "stateCanaries", "schemaValidation", "qualification", "matrixDigest"]);
  if (matrix.schemaVersion !== 2 || matrix.revision !== MATRIX_REVISION || typeof matrix.generatedAt !== "string" || !Number.isFinite(Date.parse(matrix.generatedAt))) throw new Error("matrix-envelope");
  exactKeys(matrix.provenance, ["immediatePredecessorRunId", "immediatePredecessorMatrix", "sourceSpecificationStatus", "sourceMalformedHashRetained"]); exactKeys(matrix.provenance.immediatePredecessorMatrix, ["path", "bytes", "sha256"]);
  if (typeof matrix.provenance.immediatePredecessorRunId !== "string" || matrix.provenance.immediatePredecessorMatrix.path !== R13_MATRIX || !Number.isSafeInteger(matrix.provenance.immediatePredecessorMatrix.bytes) || matrix.provenance.immediatePredecessorMatrix.bytes <= 0 || !/^[0-9a-f]{64}$/.test(matrix.provenance.immediatePredecessorMatrix.sha256) || matrix.provenance.sourceSpecificationStatus !== "matrix-spec-malformed-block1-hash-width" || matrix.provenance.sourceMalformedHashRetained !== false) throw new Error("matrix-provenance");
  exactKeys(matrix.block1SelectedHeader, ["blockNumber", "consensusDerivedBlockHash", "selectedHeaderCanonicalFingerprintDigest", "headerConsensusQualifiedFamilyCount", "minimumConsensusFamilies", "selectedFieldProfile", "completeDocumentedHyperEvmHeaderProfileEnforced", "individualCoreRootAndTimestampValuesRetainedByR13", "agreedCoreFieldsCommittedByFingerprintDigest", "blockHashRecomputed"]);
  const header = matrix.block1SelectedHeader; if (header.blockNumber !== 1 || !word(header.consensusDerivedBlockHash) || !/^[0-9a-f]{64}$/.test(header.selectedHeaderCanonicalFingerprintDigest) || header.headerConsensusQualifiedFamilyCount !== 9 || header.minimumConsensusFamilies !== 3 || !Array.isArray(header.selectedFieldProfile) || new Set(header.selectedFieldProfile).size !== header.selectedFieldProfile.length || header.completeDocumentedHyperEvmHeaderProfileEnforced !== false || header.individualCoreRootAndTimestampValuesRetainedByR13 !== false || header.agreedCoreFieldsCommittedByFingerprintDigest !== true || header.blockHashRecomputed !== false) throw new Error("matrix-selected-header");
  exactKeys(matrix.schemaValidation, ["valid", "stateCanaryCount", "uniqueIdCount", "allowedMethodCount", "mustMatchStorageReferencesValid", "unknownFieldsRejected", "candidateExpectationsOnly"]); const stateValidation = validateStateCanaries(matrix.stateCanaries); if (JSON.stringify(canonical(matrix.schemaValidation)) !== JSON.stringify(canonical(stateValidation))) throw new Error("matrix-schema-validation-summary");
  exactKeys(matrix.qualification, ["headerConsensusQualified", "archiveQualified", "stateCanariesVerified", "r14VerificationRequired", "candidateExpectationsOnly"]); if (matrix.qualification.headerConsensusQualified !== true || matrix.qualification.archiveQualified !== false || matrix.qualification.stateCanariesVerified !== false || matrix.qualification.r14VerificationRequired !== true || matrix.qualification.candidateExpectationsOnly !== true) throw new Error("matrix-qualification");
  if (!/^[0-9a-f]{64}$/.test(matrix.matrixDigest)) throw new Error("matrix-digest-format"); const digestInput = { ...matrix }; delete digestInput.matrixDigest; if (digest(digestInput) !== matrix.matrixDigest) throw new Error("matrix-digest-mismatch"); return stateValidation;
}

function parseR13SourceStrict(source, parseState) {
  exactKeys(source, ["block1Hash", "stateCanaries"]); if (typeof source.block1Hash !== "string" || !/^0x[0-9a-f]{64}$/.test(source.block1Hash)) throw new Error("matrix-spec-malformed-block1-hash-width"); return { block1Hash: source.block1Hash, state: parseState(source.stateCanaries) };
}

function sourceParserSelfTest(stateCanaries) {
  let stateParserCalls = 0; const malformedFixture = { block1Hash: `0x${"11".repeat(31)}`, stateCanaries }; let category = null;
  try { parseR13SourceStrict(malformedFixture, (rows) => { stateParserCalls++; return validateStateCanaries(rows); }); } catch (error) { category = error.message; }
  if (category !== "matrix-spec-malformed-block1-hash-width" || stateParserCalls !== 0) throw new Error("malformed-hash-first-order-test-failed"); return { implementation: "R13-only-strict-structured-source-parser", r12ParserImported: false, malformedHashCategory: category, malformedHashRejectedBeforeStateCanaryParsing: true, stateParserCallsBeforeRejection: stateParserCalls, partialHashMatching: false, hashPadding: false, hashTruncation: false };
}

function correctedStateCanaries(predecessorRows) {
  return predecessorRows.map((row) => { const base = { ...row, candidateExpectation: true, r14VerificationRequired: true }; if (row.method === "eth_call") base.storageReferenceId = row.id.includes("deployment") ? "storage-at-deployment" : "storage-at-block2m"; return canonical(base); });
}

function leakCheck(text, source = false) { if (/(?:https?|wss?):\/\//i.test(text)) throw new Error("endpoint-scheme-leak"); if (!source) { const candidates = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || []; if (candidates.some((value) => !/\.(?:json|js|md|txt|sol)$/i.test(value))) throw new Error("endpoint-host-leak"); } if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer)\s*[:=]\s*[^\s,}\]]+/i.test(text)) throw new Error("secret-material-leak"); }

function report(raw) {
  return `# 🟠 WATCH — EtherFi HyperEVM header consensus R13-r2\n\n**Run:** \`${raw.runId}\`  \n**Classification:** \`${raw.classification}\`  \n**Gates:** \`0/0/false\`; \`fork=false\`\n\n${QUALIFICATION}\n\nR13-r2 preserves nine-family agreement only as selected-header canonical fingerprint consensus. The consensus-derived block-1 hash and canonical fingerprint digest are retained. R13 did not retain individual core-root/timestamp values, so R13-r2 preserves their commitment through the fingerprint but does not re-emit or claim reconstruction of those values. Block-hash recomputation is not claimed.\n\nThe corrected matrix contains eight method-specifically schema-validated candidate state expectations. They are unverified until R14 executes them. Archive qualification, economics conclusions, and promotion remain closed.\n\n**R14 approval:** \`${raw.r14Approval.status}\`\n\nLeak checking is scoped to endpoint and secret material in the R13-r2 package; it is not an absolute secrecy claim. No endpoint/inventory reads, economics, transactions, fork, signing, or mutation occurred.\n\n**nextReadOnlyStep:** ${raw.nextReadOnlyStep}\n`;
}

function main() {
  const predecessor = readJson(R13_RAW); const predecessorMatrix = readJson(R13_MATRIX); if (predecessor.consensus.status !== "PASS" || predecessor.consensus.familyCount !== 9 || !/^0x[0-9a-f]{64}$/.test(predecessor.consensus.correctedBlockHash) || !/^[0-9a-f]{64}$/.test(predecessor.consensus.fullHeaderCanonicalDigest)) throw new Error("r13-consensus-predecessor-invalid");
  const stateCanaries = correctedStateCanaries(predecessorMatrix.stateCanaries); const positiveSchema = validateStateCanaries(stateCanaries); const parserValidation = sourceParserSelfTest(stateCanaries);
  const corrected = canonical({ schemaVersion: 2, revision: MATRIX_REVISION, generatedAt: new Date().toISOString(), provenance: { immediatePredecessorRunId: predecessor.runId, immediatePredecessorMatrix: hashFile(R13_MATRIX), sourceSpecificationStatus: "matrix-spec-malformed-block1-hash-width", sourceMalformedHashRetained: false }, block1SelectedHeader: { blockNumber: 1, consensusDerivedBlockHash: predecessor.consensus.correctedBlockHash, selectedHeaderCanonicalFingerprintDigest: predecessor.consensus.fullHeaderCanonicalDigest, headerConsensusQualifiedFamilyCount: 9, minimumConsensusFamilies: 3, selectedFieldProfile: ["number", "hash", "parentHash", "stateRoot", "transactionsRoot", "receiptsRoot", "timestamp", "documented optional fields when present"], completeDocumentedHyperEvmHeaderProfileEnforced: false, individualCoreRootAndTimestampValuesRetainedByR13: false, agreedCoreFieldsCommittedByFingerprintDigest: true, blockHashRecomputed: false }, stateCanaries, schemaValidation: positiveSchema, qualification: { headerConsensusQualified: true, archiveQualified: false, stateCanariesVerified: false, r14VerificationRequired: true, candidateExpectationsOnly: true } }); corrected.matrixDigest = digest(corrected); validateCorrectedMatrix(corrected); writeOwned(CORRECTED_MATRIX, JSON.stringify(corrected, null, 2) + "\n");
  const predecessorBinding = { status: "IMMUTABLE-PREDECESSOR/HYPEREVM-R13", runId: predecessor.runId, raw: hashFile(R13_RAW), manifest: hashFile(R13_MANIFEST), correctedMatrix: hashFile(R13_MATRIX), manifestAggregateSha256: readJson(R13_MANIFEST).aggregateSha256 };
  const nextReadOnlyStep = "Execute R14 read-only state-canary verification using only the R13-r2 corrected matrix; require exact method-specific results before any archive qualification or broader promotion.";
  const raw = canonical({ schemaVersion: 1, revision: REVISION, generatedAt: new Date().toISOString(), scanner: SCANNER, agentId: AGENT, role: "critical-research", classification: CLASSIFICATION, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, sourceParserValidation: parserValidation, selectedHeaderConsensus: { terminology: "selected-header canonical fingerprint consensus", headerConsensusQualifiedFamilyCount: 9, archiveQualifiedFamilyCount: 0, fingerprintGroupCount: 1, exactFingerprintAgreement: true, consensusDerivedBlockHash: predecessor.consensus.correctedBlockHash, selectedHeaderCanonicalFingerprintDigest: predecessor.consensus.fullHeaderCanonicalDigest, blockHashRecomputed: false, completeDocumentedHyperEvmHeaderProfileEnforced: false, individualCoreRootAndTimestampValuesRetainedByR13: false, agreedCoreFieldsCommittedByFingerprintDigest: true }, correctedMatrix: { path: CORRECTED_MATRIX, sha256: hashFile(CORRECTED_MATRIX).sha256, matrixDigest: corrected.matrixDigest, schemaValidated: true, stateExpectationCount: 8, candidateExpectationsOnly: true, stateCanariesVerified: false }, schemaValidation: { positive: positiveSchema, negativeFixturesRequiredByValidator: true }, immutablePredecessorR13: predecessorBinding, r14Approval: { status: R14_STATUS, readOnlyStateCanaryTestingApproved: true, archiveQualificationApproved: false, economicsApproved: false, promotionApproved: false }, gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, archiveQualificationClosed: true, economicsClosed: true, promotionClosed: true }, leakGate: { scope: "endpoint-and-secret-material-in-r13-r2-package", scopedNotAbsolute: true, endpointUrlHostChecks: true, credentialHeaderTokenChecks: true, absoluteSecrecyClaim: false }, safety: { offline: true, endpointReads: false, inventoryReads: false, sourceMarkdownReads: false, r12ParserImported: false, behavioralRoutes: false, anchors: false, economics: false, transactions: false, forkCreated: false, signing: false, mutation: false }, nextReadOnlyStep });
  raw.runId = `etherfi-hyperevm-header-consensus-r13-r2-${digest(raw)}-${hashFile(SCANNER).sha256}`; writeOwned(RAW, JSON.stringify(raw, null, 2) + "\n"); writeOwned(REPORT, report(raw));
  const records = [SCANNER, VALIDATOR, RAW, REPORT, CORRECTED_MATRIX, R13_RAW, R13_MANIFEST, R13_MATRIX].map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))); const manifest = canonical({ schemaVersion: 1, revision: REVISION, runId: raw.runId, generatedAt: raw.generatedAt, classification: CLASSIFICATION, algorithm: "sha256", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, sourceParserValidation: parserValidation, selectedHeaderConsensus: raw.selectedHeaderConsensus, correctedMatrix: raw.correctedMatrix, schemaValidation: raw.schemaValidation, immutablePredecessorR13: predecessorBinding, r14Approval: raw.r14Approval, gates: raw.gates, leakGate: raw.leakGate, safety: raw.safety, records, aggregateSha256 }); writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, CORRECTED_MATRIX]) leakCheck(read(rel), rel === SCANNER || rel === VALIDATOR); process.stdout.write(JSON.stringify({ runId: raw.runId, classification: CLASSIFICATION, headerConsensusQualifiedFamilies: 9, archiveQualifiedFamilies: 0, correctedMatrix: raw.correctedMatrix, sourceParserValidation: parserValidation, schemaValidation: positiveSchema, r14Approval: raw.r14Approval, manifestAggregateSha256: aggregateSha256, checks: raw.safety, nextReadOnlyStep }) + "\n");
}

main();
