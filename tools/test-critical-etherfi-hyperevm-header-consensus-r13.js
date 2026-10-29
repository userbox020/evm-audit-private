#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-hyperevm-header-consensus-r13";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-23-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-23-${NAME}-handoff.md`;
const CORRECTED_MATRIX = `reports/raw/fast/${NAME}-corrected-historical-matrix.json`;
const R12_RAW = "reports/raw/fast/critical-etherfi-behype-hyperevm-requalification-r12.json";
const R12_MANIFEST = "reports/raw/fast/critical-etherfi-behype-hyperevm-requalification-r12-manifest.json";
const REVISION = "etherfi-hyperevm-header-consensus-r13-block1-full-header";
const MATRIX_REVISION = "etherfi-hyperevm-historical-matrix-r13-corrected-block1-hash";
const AGENT = "critical-etherfi-hyper-header-r13-20260723";
const QUALIFICATION = "Agreeing hostname-derived provider-family groups are anonymous; backend/operator independence is not established.";

const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };

const raw = readJson(RAW); const manifest = readJson(MANIFEST); const report = read(REPORT); const inbox = readJson(INBOX); const handoff = read(HANDOFF); const r12 = readJson(R12_RAW);

assert.strictEqual(raw.schemaVersion, 1); assert.strictEqual(raw.revision, REVISION); assert.strictEqual(raw.scanner, SCANNER); assert.strictEqual(raw.agentId, AGENT); assert(raw.runId.startsWith("etherfi-hyperevm-header-consensus-r13-")); assert.strictEqual(raw.providerFamilyQualification, QUALIFICATION); assert.strictEqual(raw.backendOperatorIndependenceEstablished, false); assert.strictEqual(raw.backendOperatorIndependenceClaimed, false); assert.strictEqual(raw.routePositive, 0); assert.strictEqual(raw.executableNow, 0); assert.strictEqual(raw.signedActionJustified, false); assert.strictEqual(raw.fork, false);
assert.deepStrictEqual(raw.sourceMatrixSchema, { classification: "matrix-spec-malformed-block1-hash-width", expectedBytes: 32, observedBytes: 31, paddingUsed: false, prefixMatchingUsed: false, substringMatchingUsed: false, suffixMatchingUsed: false, trustedForConsensus: false });
assert(raw.metrics.archiveCandidatesTested >= raw.metrics.strictHeaderCandidates); assert(raw.metrics.archiveQualifiedFamilies >= raw.metrics.consensusFamilies); assert.strictEqual(raw.metrics.fingerprintGroupCount, raw.fingerprintGroups.length); assert.strictEqual(raw.consensus.threshold, 3); assert.strictEqual(raw.consensus.familyCount, raw.metrics.consensusFamilies); assert.strictEqual(raw.consensus.status === "PASS", raw.consensus.familyCount >= 3); assert.strictEqual(raw.consensus.exactAgreement, raw.consensus.status === "PASS");
for (const group of raw.fingerprintGroups) { assert(/^[0-9a-f]{64}$/.test(group.fingerprint)); assert(Number.isSafeInteger(group.familyCount) && group.familyCount >= 1); }

if (raw.consensus.status === "PASS") {
  assert(raw.classification.includes("PREFLIGHT-PASS")); assert(raw.metrics.consensusFamilies >= 3); assert(/^0x[0-9a-f]{64}$/.test(raw.consensus.correctedBlockHash)); assert(/^[0-9a-f]{64}$/.test(raw.consensus.fullHeaderCanonicalDigest)); assert.strictEqual(raw.correctedMatrix.emitted, true); assert.strictEqual(raw.correctedMatrix.path, CORRECTED_MATRIX); assert.strictEqual(raw.correctedMatrix.schemaValidated, true); assert.deepStrictEqual(hashFile(CORRECTED_MATRIX).sha256, raw.correctedMatrix.sha256);
  const corrected = readJson(CORRECTED_MATRIX); assert.strictEqual(corrected.schemaVersion, 1); assert.strictEqual(corrected.revision, MATRIX_REVISION); assert.strictEqual(corrected.sourceSpecificationStatus, "matrix-spec-malformed-block1-hash-width"); assert.strictEqual(corrected.sourceMalformedHashRetained, false); assert.strictEqual(corrected.block1Header.blockNumber, 1); assert.strictEqual(corrected.block1Header.fullBlockHash, raw.consensus.correctedBlockHash); assert.strictEqual(corrected.block1Header.fullHeaderCanonicalDigest, raw.consensus.fullHeaderCanonicalDigest); assert.strictEqual(corrected.block1Header.consensusFamilyCount, raw.consensus.familyCount); assert.strictEqual(corrected.block1Header.minimumConsensusFamilies, 3); assert.strictEqual(corrected.stateCanaries.length, 8); assert.strictEqual(corrected.schemaValidation.fullBlockHash32Bytes, true); assert.strictEqual(corrected.schemaValidation.stateCanaryCount, 8); assert.strictEqual(corrected.schemaValidation.stateCanariesSchemaValid, true); assert.strictEqual(corrected.schemaValidation.substringPrefixSuffixOrPaddingUsed, false); assert(/^[0-9a-f]{64}$/.test(corrected.matrixDigest)); assert(!read(CORRECTED_MATRIX).includes("matrix-check-failed"));
} else { assert(raw.classification.includes("CONSENSUS-NOT-MET")); assert.strictEqual(raw.consensus.correctedBlockHash, null); assert.strictEqual(raw.correctedMatrix.emitted, false); assert.strictEqual(raw.correctedMatrix.path, null); }

assert.deepStrictEqual(raw.immutablePredecessorR12.raw, hashFile(R12_RAW)); assert.deepStrictEqual(raw.immutablePredecessorR12.manifest, hashFile(R12_MANIFEST)); assert.strictEqual(raw.immutablePredecessorR12.runId, r12.runId);
assert.strictEqual(raw.gates.routePositive, 0); assert.strictEqual(raw.gates.executableNow, 0); assert.strictEqual(raw.gates.signedActionJustified, false); assert.strictEqual(raw.gates.fork, false); assert.strictEqual(raw.safety.readOnly, true); assert.strictEqual(raw.safety.boundedPass, true); assert.strictEqual(raw.safety.rawInventoryPersisted, false); assert.strictEqual(raw.safety.endpointIdentifiersPersisted, false); assert.strictEqual(raw.safety.providerNamesPersisted, false); assert.strictEqual(raw.safety.providerDomainsPersisted, false); assert.strictEqual(raw.safety.keysPersisted, false); assert.strictEqual(raw.safety.headersPersisted, false); assert.strictEqual(raw.safety.substringMatchingUsed, false); assert.strictEqual(raw.safety.prefixMatchingUsed, false); assert.strictEqual(raw.safety.suffixMatchingUsed, false); assert.strictEqual(raw.safety.paddingUsed, false); assert.strictEqual(raw.safety.behavioralRoutes, false); assert.strictEqual(raw.safety.anchors, false); assert.strictEqual(raw.safety.economics, false); assert.strictEqual(raw.safety.transactions, false); assert.strictEqual(raw.safety.forkCreated, false); assert.strictEqual(raw.safety.signing, false); assert.strictEqual(raw.safety.mutation, false);

assert.strictEqual(manifest.schemaVersion, 1); assert.strictEqual(manifest.revision, REVISION); assert.strictEqual(manifest.runId, raw.runId); assert.strictEqual(manifest.classification, raw.classification); assert.deepStrictEqual(manifest.sourceMatrixSchema, raw.sourceMatrixSchema); assert.deepStrictEqual(manifest.metrics, raw.metrics); assert.deepStrictEqual(manifest.fingerprintGroups, raw.fingerprintGroups); assert.deepStrictEqual(manifest.consensus, raw.consensus); assert.deepStrictEqual(manifest.correctedMatrix, raw.correctedMatrix); assert.deepStrictEqual(manifest.exclusions, raw.exclusions); assert.deepStrictEqual(manifest.gates, raw.gates); assert.deepStrictEqual(manifest.safety, raw.safety);
assert.strictEqual(inbox.runId, raw.runId); assert.strictEqual(inbox.agentId, AGENT); assert.strictEqual(inbox.classification, raw.classification); assert.deepStrictEqual(inbox.consensus, raw.consensus); assert.deepStrictEqual(inbox.correctedMatrix, raw.correctedMatrix); assert.strictEqual(inbox.routePositive, 0); assert.strictEqual(inbox.executableNow, 0); assert.strictEqual(inbox.signedActionJustified, false); assert.strictEqual(inbox.fork, false); assert(report.includes(raw.runId)); assert(report.includes(raw.classification)); assert(report.includes(QUALIFICATION)); assert(report.includes("matrix-spec-malformed-block1-hash-width")); assert(handoff.includes(raw.runId)); assert(handoff.includes(raw.classification)); assert(handoff.includes(QUALIFICATION));

for (const record of manifest.records) assert.deepStrictEqual(record, hashFile(record.path), record.path); assert.strictEqual(sha(Buffer.from(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))), manifest.aggregateSha256);
for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, ...(raw.correctedMatrix.emitted ? [CORRECTED_MATRIX] : [])]) { const text = read(rel); const source = [SCANNER, VALIDATOR].includes(rel); assert(!/(?:https?|wss?):\/\//i.test(text), `scheme leak ${rel}`); if (!source) { const hosts = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || []; assert(!hosts.some((value) => !/\.(?:json|js|md|txt|sol)$/i.test(value)), `host leak ${rel}`); } }

process.stdout.write(`PASS EtherFi HyperEVM R13 (${raw.runId}; candidates=${raw.metrics.archiveCandidatesTested}; headerFamilies=${raw.metrics.archiveQualifiedFamilies}; consensusFamilies=${raw.metrics.consensusFamilies}; status=${raw.consensus.status}; correctedMatrix=${raw.correctedMatrix.emitted}; aggregate=${manifest.aggregateSha256})\n`);
