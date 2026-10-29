#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-hyperevm-requalification-r12";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-23-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-23-${NAME}-handoff.md`;
const R11_RAW = "reports/raw/fast/critical-etherfi-behype-hyperevm-consensus-r11.json";
const R11_MANIFEST = "reports/raw/fast/critical-etherfi-behype-hyperevm-consensus-r11-manifest.json";
const R10R2_RAW = "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10-r2.json";
const R10R2_MANIFEST = "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10-r2-manifest.json";
const R8_RAW = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check.json";
const R8_MANIFEST = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check-manifest.json";
const STEP4_RAW = "reports/raw/fast/critical-etherfi-behype-staker-layerzero-binding.json";
const STEP4_MANIFEST = "reports/raw/fast/critical-etherfi-behype-staker-layerzero-binding-manifest.json";
const REVISION = "etherfi-behype-hyperevm-requalification-r12-exact-canary-canonical-anchor";
const AGENT = "critical-etherfi-behype-hyper-requal-r12-20260723";
const QUALIFICATION = "Families are anonymous hostname-derived declared/observed groups; backend/operator independence is not established.";

const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const raw = readJson(RAW); const manifest = readJson(MANIFEST); const report = read(REPORT); const inbox = readJson(INBOX); const handoff = read(HANDOFF); const r11 = readJson(R11_RAW);

assert.strictEqual(raw.schemaVersion, 1); assert.strictEqual(raw.revision, REVISION); assert.strictEqual(raw.scanner, SCANNER); assert.strictEqual(raw.agentId, AGENT); assert(raw.runId.startsWith("etherfi-behype-hyperevm-requalification-r12-")); assert.strictEqual(raw.providerFamilyQualification, QUALIFICATION); assert.strictEqual(raw.backendOperatorIndependenceEstablished, false); assert.strictEqual(raw.backendOperatorIndependenceClaimed, false);
assert.strictEqual(raw.routePositive, 0); assert.strictEqual(raw.executableNow, 0); assert.strictEqual(raw.signedActionJustified, false); assert.strictEqual(raw.fork, false);
if (raw.pin) { assert(Number.isSafeInteger(raw.pin.blockNumber) && raw.pin.blockNumber > r11.pin.blockNumber); assert(/^0x[0-9a-f]{64}$/.test(raw.pin.blockHash)); assert.strictEqual(raw.pin.exactPinFamilyCount, raw.metrics.exactPinFamilies); assert.strictEqual(raw.pin.commonPinHashAgreement, raw.metrics.exactPinFamilies >= 2); }
else { assert.strictEqual(raw.metrics.activeCanaryPassFamilies, 0); assert.strictEqual(raw.metrics.exactPinFamilies, 0); assert(raw.classification.includes("ACTIVE-HISTORICAL-CANARY-THRESHOLD-NOT-MET")); }

assert.strictEqual(raw.activeHistoricalMatrix.precommittedCheckCount, 9); assert.strictEqual(raw.activeHistoricalMatrix.exactExpectedRequired, true); assert.strictEqual(raw.activeHistoricalMatrix.sensitiveExpectedValuesPersisted, false); assert.strictEqual(raw.activeHistoricalMatrix.acceptedFamilyDigestAgreementCount, raw.metrics.activeCanaryPassFamilies);
assert.strictEqual(raw.metrics.activeCanaryPassFamilies, raw.families.filter((row) => row.activeCanaryPass).length); assert.strictEqual(raw.metrics.exactPinFamilies, raw.families.filter((row) => row.exactPin).length); assert.strictEqual(raw.metrics.finalizedFamiliesAtPin, raw.families.filter((row) => row.finalizedAtPin).length); assert.strictEqual(raw.metrics.fullBehavioralFamilies, raw.families.filter((row) => row.fullBehavioralComplete).length);
for (const family of raw.families) {
  assert(/^hyperevm-family-\d{2,3}$/.test(family.familyId)); assert.strictEqual(family.activeCanaryPass, true); assert.strictEqual(family.activeCanaryCheckCount, 9); assert.strictEqual(family.activeCanaryExactMatchCount, 9); assert(/^[0-9a-f]{64}$/.test(family.activeCanaryMatrixDigest)); assert.strictEqual(family.duplicateConflictCount, 0);
  assert(["exact-canonical", "namespace-variant-semantic-normalized", "semantic-anchor-divergent-excluded", "behavior-or-anchor-excluded"].includes(family.namespaceMode));
  if (!family.fullBehavioralComplete) continue; assert.strictEqual(family.anchorSchemaValid, true); assert(/^[0-9a-f]{64}$/.test(family.behavioralDigest)); assert(/^[0-9a-f]{64}$/.test(family.exactAnchorDigest)); assert(/^[0-9a-f]{64}$/.test(family.semanticAnchorDigest)); assert.strictEqual(family.routes.length, 2);
  const receive = family.routes.find((route) => route.routeLabel === "whype-receive-30111"); const send = family.routes.find((route) => route.routeLabel === "behype-send-30111"); assert(receive && send); assert.strictEqual(receive.routeComplete, true); assert.strictEqual(send.routeComplete, true); assert.strictEqual(receive.checks["receive-type1-negative"].status, "success"); assert(["expected-custom-error", "expected-custom-error-from-wrapped-response"].includes(receive.checks["receive-type1-negative"].category)); assert.strictEqual(send.checks["receive-type1-negative"].status, "not-applicable");
  for (const route of family.routes) { const anchor = route.checks.anchor; assert.strictEqual(anchor.status, "success"); assert.strictEqual(anchor.category, "canonical-anchor-bound"); assert.strictEqual(anchor.blockCount <= 50, true); assert.strictEqual(anchor.schemaErrors, 0); assert.strictEqual(anchor.duplicateConflicts, 0); assert(/^[0-9a-f]{64}$/.test(anchor.digests.exactAnchorDigest)); assert(/^[0-9a-f]{64}$/.test(anchor.digests.semanticAnchorDigest)); assert.strictEqual(route.checks["pin-recheck"].status, "success"); }
}

const groupCount = (key, rows) => { const groups = new Map(); for (const row of rows) { const set = groups.get(row[key]) || new Set(); set.add(row.familyId); groups.set(row[key], set); } return Math.max(0, ...[...groups.values()].map((set) => set.size)); };
const complete = raw.families.filter((row) => row.fullBehavioralComplete && row.anchorSchemaValid); const behavioralCount = groupCount("behavioralDigest", complete); assert.strictEqual(raw.metrics.fullBehavioralMatchingFamilies, behavioralCount); assert.strictEqual(raw.canonicalAnchor.exactAgreementFamilies, raw.metrics.exactAnchorAgreementFamilies); assert.strictEqual(raw.canonicalAnchor.semanticAgreementFamilies, raw.metrics.semanticAnchorAgreementFamilies); assert.strictEqual(raw.canonicalAnchor.strictSchemaValidation, true); assert.strictEqual(raw.canonicalAnchor.caseAndQuantityNormalization, true); assert.strictEqual(raw.canonicalAnchor.deterministicSort, true); assert.strictEqual(raw.canonicalAnchor.deduplication, true); assert.strictEqual(raw.canonicalAnchor.duplicateConflictDetection, true); assert.strictEqual(raw.canonicalAnchor.namespaceDependentTransactionHashesHidden, false);
assert.strictEqual(Object.values(raw.namespaceModes).reduce((sum, count) => sum + count, 0), raw.families.length); assert.strictEqual(raw.metrics.preferredMatchingFamilies, raw.canonicalAnchor.semanticAgreementFamilies <= raw.metrics.fullBehavioralMatchingFamilies ? raw.canonicalAnchor.semanticAgreementFamilies : raw.metrics.fullBehavioralMatchingFamilies);

assert.strictEqual(raw.readiness.minimumThreshold, 2); assert.strictEqual(raw.readiness.minimumThresholdMet, raw.metrics.preferredMatchingFamilies >= 2); assert.strictEqual(raw.readiness.preferredThreshold, 3); assert.strictEqual(raw.readiness.preferredThresholdMet, raw.metrics.preferredMatchingFamilies >= 3); assert.strictEqual(raw.readiness.economicsModelDesignReady, raw.readiness.minimumThresholdMet); assert.strictEqual(raw.readiness.promotableConclusionReady, false); assert.strictEqual(raw.readiness.independentReviewerApprovalRequired, true);
assert.strictEqual(raw.classification.includes("PREFERRED-THREE-FAMILY"), raw.readiness.preferredThresholdMet); assert.strictEqual(raw.graphqlExcludedFromConsensus, true); assert.strictEqual(raw.gates.economicsPromotionClosed, true); assert.strictEqual(raw.gates.routePositive, 0); assert.strictEqual(raw.gates.executableNow, 0); assert.strictEqual(raw.gates.signedActionJustified, false); assert.strictEqual(raw.gates.fork, false);

assert.strictEqual(raw.routeBinding.step4CurrentBindingPresent, true); assert.strictEqual(raw.routeBinding.step4RouteFieldsMatch, true); assert.strictEqual(raw.routeBinding.r10RouteFieldsMatch, true); assert.strictEqual(raw.routeBinding.r8BehavioralPredecessorReady, true); assert.strictEqual(raw.routeBinding.r11PredecessorRunBound, true); assert.strictEqual(raw.routeBinding.step4DeliveryFinalityProof, false); assert.strictEqual(raw.routeBinding.step4LimitationsRetained, true);
for (const [key, files] of Object.entries({ step4: [STEP4_RAW, STEP4_MANIFEST], r8r2: [R8_RAW, R8_MANIFEST], r10r2: [R10R2_RAW, R10R2_MANIFEST], r11: [R11_RAW, R11_MANIFEST] })) { assert.deepStrictEqual(raw.immutablePredecessors[key].raw, hashFile(files[0])); assert.deepStrictEqual(raw.immutablePredecessors[key].manifest, hashFile(files[1])); assert.strictEqual(typeof raw.immutablePredecessors[key].runId, "string"); }

assert.strictEqual(raw.leakGate.scopedNotAbsolute, true); assert.strictEqual(raw.leakGate.broadUrlHostDetection, true); assert.strictEqual(raw.leakGate.parsedInventoryTokenChecks, true); assert.strictEqual(raw.leakGate.parsedHeaderChecks, true); assert.strictEqual(raw.leakGate.rawSensitiveLineChecks, true); assert.strictEqual(raw.leakGate.leaksDetected, false);
assert.strictEqual(raw.safety.readOnly, true); assert.strictEqual(raw.safety.boundedPass, true); assert.strictEqual(raw.safety.graphqlRead, false); for (const key of ["rawResponsesPersisted", "rawInventoryLinesPersisted", "endpointIdentifiersPersisted", "providerNamesPersisted", "providerDomainsPersisted", "keysPersisted", "headersPersisted", "economicsCalls", "transactions", "stakeCalls", "messageSendCalls", "protocolRetryCalls", "sweepCalls", "signing", "forkCreated", "mutation"]) assert.strictEqual(raw.safety[key], false, key);

assert.strictEqual(manifest.schemaVersion, 1); assert.strictEqual(manifest.revision, REVISION); assert.strictEqual(manifest.runId, raw.runId); assert.strictEqual(manifest.classification, raw.classification); assert.deepStrictEqual(manifest.pin, raw.pin); assert.deepStrictEqual(manifest.metrics, raw.metrics); assert.deepStrictEqual(manifest.canonicalAnchor, raw.canonicalAnchor); assert.deepStrictEqual(manifest.namespaceModes, raw.namespaceModes); assert.deepStrictEqual(manifest.routeBinding, raw.routeBinding); assert.deepStrictEqual(manifest.readiness, raw.readiness); assert.deepStrictEqual(manifest.blockers, raw.blockers); assert.deepStrictEqual(manifest.gates, raw.gates); assert.deepStrictEqual(manifest.leakGate, raw.leakGate); assert.deepStrictEqual(manifest.safety, raw.safety);
assert.strictEqual(inbox.runId, raw.runId); assert.strictEqual(inbox.agentId, AGENT); assert.strictEqual(inbox.classification, raw.classification); assert.deepStrictEqual(inbox.metrics, raw.metrics); assert.deepStrictEqual(inbox.readiness, raw.readiness); assert.strictEqual(inbox.routePositive, 0); assert.strictEqual(inbox.executableNow, 0); assert.strictEqual(inbox.signedActionJustified, false); assert.strictEqual(inbox.fork, false);
assert(report.includes(raw.runId)); assert(report.includes(raw.classification)); assert(report.includes(QUALIFICATION)); assert(report.includes("not delivery-finality proof")); if (!raw.pin) assert(report.includes("No fresh common pin was selected")); assert(handoff.includes(raw.runId)); assert(handoff.includes(raw.classification)); assert(handoff.includes(QUALIFICATION));

for (const record of manifest.records) assert.deepStrictEqual(record, hashFile(record.path), record.path); assert.strictEqual(sha(Buffer.from(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))), manifest.aggregateSha256);
for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) { const text = read(rel); const source = [SCANNER, VALIDATOR].includes(rel); assert(!/(?:https?|wss?):\/\//i.test(text), `scheme leak ${rel}`); if (!source) { const hosts = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || []; assert(!hosts.some((value) => !/\.(?:json|js|md|txt|sol)$/i.test(value)), `broad host leak ${rel}`); assert(!/"(?:url|domain|providerName|rawLine|headers?|address|endpointId|endpointIdentifier)"\s*:/i.test(text), `identifier field leak ${rel}`); } }
const generated = [RAW, MANIFEST, REPORT, INBOX, HANDOFF].map(read).join("\n"); assert(!/0x[0-9a-f]{40}(?![0-9a-f])/i.test(generated), "target address leak");

process.stdout.write(`PASS EtherFi BeHYPE HyperEVM R12 (${raw.runId}; canary=${raw.metrics.activeCanaryPassFamilies}; behavior=${raw.metrics.fullBehavioralMatchingFamilies}; exactAnchor=${raw.metrics.exactAnchorAgreementFamilies}; semanticAnchor=${raw.metrics.semanticAnchorAgreementFamilies}; preferred=${raw.metrics.preferredMatchingFamilies}; designReady=${raw.readiness.economicsModelDesignReady}; promotable=${raw.readiness.promotableConclusionReady}; aggregate=${manifest.aggregateSha256})\n`);
