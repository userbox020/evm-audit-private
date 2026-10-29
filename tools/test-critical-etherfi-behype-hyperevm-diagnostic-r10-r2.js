#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-hyperevm-diagnostic-r10-r2";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const R10_RAW = "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10.json";
const R10_MANIFEST = "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10-manifest.json";
const REVISION = "etherfi-behype-hyperevm-diagnostic-r10-r2-audit-reviewer-wording-correction";
const AGENT = "critical-etherfi-behype-r10-wording-20260722";
const CLASSIFICATION = "WATCH/COVERAGE_OPEN/HYPEREVM-SOLE-FAMILY-FULL-BEHAVIORAL-OBSERVATION/PROVISIONAL-FINALITY/NO-BACKEND-INDEPENDENCE-CLAIM";
const SUMMARY = "One declared/observed provider-family group completed the selected-library behavioral tuple at a sole-family provisional reported-finalized pin; this is not cross-family finality/hash consensus and does not establish backend/operator independence.";

const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };

const raw = readJson(RAW); const manifest = readJson(MANIFEST); const report = read(REPORT); const inbox = readJson(INBOX); const handoff = read(HANDOFF); const predecessor = readJson(R10_RAW); const predecessorManifest = readJson(R10_MANIFEST);

assert.strictEqual(raw.schemaVersion, 1);
assert.strictEqual(raw.revision, REVISION);
assert.strictEqual(raw.scanner, SCANNER);
assert.strictEqual(raw.agentId, AGENT);
assert(raw.runId.startsWith("etherfi-behype-hyperevm-diagnostic-r10-r2-"));
assert.strictEqual(raw.classification, CLASSIFICATION);
assert.strictEqual(raw.summary, SUMMARY);
assert.strictEqual(raw.evidenceCaptureGeneratedAt, predecessor.generatedAt);
assert.strictEqual(raw.backendOperatorIndependenceEstablished, false);
assert.strictEqual(raw.backendOperatorIndependenceClaimed, false);

const preservedKeys = ["failureCategoryEnum", "failureSubstageEnum", "families", "fork", "gates", "immutablePredecessorR8", "immutablePredecessorR9", "metrics", "nextReadOnlyStep", "offlineFinalization", "pin", "providerFamilyQualification", "providers", "retainedStep4Binding", "routeDefinitionComparison", "routePositive", "safety", "signedActionJustified", "executableNow"];
for (const key of preservedKeys) assert.deepStrictEqual(raw[key], predecessor[key], `preserved ${key}`);

assert.deepStrictEqual(raw.offlineCorrectionR2, { classificationWordingChanged: true, endpointInventoryReads: false, evidenceValuesChanged: false, gatesChanged: false, networkCalls: false, nextActionChanged: false, reportPresentationChanged: true, routeCheckStatusesChanged: false });
assert.strictEqual(raw.metrics.exactPinFamilies, 1);
assert.strictEqual(raw.metrics.exactPinProviders, 1);
assert.strictEqual(raw.metrics.completeRouteCount, 2);
assert.strictEqual(raw.pin.qualification, "sole-family-provisional-reported-finalized-candidate");
assert.strictEqual(raw.pin.crossFamilyFinalityConsensus, false);
assert.strictEqual(raw.pin.crossFamilyHashConsensus, false);
assert.strictEqual(raw.gates.crossFamilyConsensus, false);
assert.strictEqual(raw.gates.economicsBlocked, true);
assert.strictEqual(raw.gates.routePositive, 0);
assert.strictEqual(raw.gates.executableNow, 0);
assert.strictEqual(raw.gates.signedActionJustified, false);
assert.strictEqual(raw.gates.fork, false);

const receive = raw.providers[0].routes.find((route) => route.routeLabel === "whype-receive-30111");
const send = raw.providers[0].routes.find((route) => route.routeLabel === "behype-send-30111");
assert(receive && send);
assert.strictEqual(receive.checks["receive-type1-negative"].status, "success");
assert.strictEqual(receive.checks["receive-type1-negative"].category, "expected-custom-error");
assert.strictEqual(send.checks["receive-type1-negative"].status, "not-applicable");
assert.strictEqual(send.checks["receive-type1-negative"].category, "direction-not-applicable");
assert(send.successfulSubstages.includes("receive-type1-negative"), "raw R10 status-derived list preserved");
assert.strictEqual(send.successfulSubstageCount, 10);

const receivePresentation = raw.reportPresentation.find((route) => route.routeLabel === receive.routeLabel);
const sendPresentation = raw.reportPresentation.find((route) => route.routeLabel === send.routeLabel);
assert(receivePresentation && sendPresentation);
assert(receivePresentation.successfulEvidence.includes("receive-type1-negative"));
assert.deepStrictEqual(receivePresentation.directionNotApplicable, []);
assert(!sendPresentation.successfulEvidence.includes("receive-type1-negative"));
assert.deepStrictEqual(sendPresentation.directionNotApplicable, ["receive-type1-negative"]);
assert.strictEqual(sendPresentation.successfulEvidence.length, 9);
assert.strictEqual(sendPresentation.routeComplete, true);

const reportLines = report.split("\n");
const receiveLine = reportLines.find((line) => line.startsWith("| whype-receive-30111 |"));
const sendLine = reportLines.find((line) => line.startsWith("| behype-send-30111 |"));
assert(receiveLine && sendLine);
assert(receiveLine.split("|")[2].includes("receive-type1-negative"));
assert.strictEqual(receiveLine.split("|")[3].trim(), "none");
assert(!sendLine.split("|")[2].includes("receive-type1-negative"));
assert.strictEqual(sendLine.split("|")[3].trim(), "receive-type1-negative");
assert(report.includes("raw route check remains `status=not-applicable`"));

assert.strictEqual(raw.immutablePredecessorR10.status, "IMMUTABLE-PREDECESSOR/HYPEREVM-R10");
assert.strictEqual(raw.immutablePredecessorR10.runId, predecessor.runId);
assert.deepStrictEqual(raw.immutablePredecessorR10.raw, hashFile(R10_RAW));
assert.deepStrictEqual(raw.immutablePredecessorR10.manifest, hashFile(R10_MANIFEST));
assert.strictEqual(raw.immutablePredecessorR10.manifestAggregateSha256, predecessorManifest.aggregateSha256);

assert.strictEqual(manifest.schemaVersion, 1);
assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(manifest.classification, CLASSIFICATION);
assert.strictEqual(manifest.summary, SUMMARY);
assert.deepStrictEqual(manifest.pin, raw.pin);
assert.deepStrictEqual(manifest.metrics, raw.metrics);
assert.deepStrictEqual(manifest.reportPresentation, raw.reportPresentation);
assert.deepStrictEqual(manifest.immutablePredecessorR10, raw.immutablePredecessorR10);
assert.deepStrictEqual(manifest.offlineCorrectionR2, raw.offlineCorrectionR2);
assert.deepStrictEqual(manifest.gates, raw.gates);
assert.deepStrictEqual(manifest.safety, raw.safety);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(inbox.agentId, AGENT);
assert.strictEqual(inbox.classification, CLASSIFICATION);
assert.strictEqual(inbox.summary, SUMMARY);
assert.deepStrictEqual(inbox.routePresentation, raw.reportPresentation);
assert.deepStrictEqual(inbox.immutablePredecessorR10, raw.immutablePredecessorR10);
assert.strictEqual(inbox.routePositive, 0);
assert.strictEqual(inbox.executableNow, 0);
assert.strictEqual(inbox.signedActionJustified, false);
assert.strictEqual(inbox.fork, false);

for (const text of [report, handoff]) { assert(text.includes(raw.runId)); assert(text.includes(CLASSIFICATION)); assert(text.includes(SUMMARY)); }
for (const rel of [RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assert(!read(rel).includes(predecessor.classification), `old classification leaked ${rel}`);
for (const record of manifest.records) assert.deepStrictEqual(record, hashFile(record.path), record.path);
assert.strictEqual(sha(Buffer.from(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))), manifest.aggregateSha256);

for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) {
  const published = read(rel);
  assert(!/(?:https?|wss?):\/\//i.test(published), `scheme leak ${rel}`);
  assert(!/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(published), `host leak ${rel}`);
  assert(!/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(published), `credential leak ${rel}`);
  assert(!/"(?:url|domain|providerName|rawLine|headers?|address)"\s*:/i.test(published), `identifier field leak ${rel}`);
}
const generated = [RAW, MANIFEST, REPORT, INBOX, HANDOFF].map(read).join("\n");
assert(!/0x[0-9a-f]{40}(?![0-9a-f])/i.test(generated), "target address leak");

process.stdout.write(`PASS EtherFi BeHYPE HyperEVM R10-r2 (${raw.runId}; predecessor=${predecessor.runId}; receiveType1=${receive.checks["receive-type1-negative"].status}; sendType1=${send.checks["receive-type1-negative"].status}; sendReportSuccess=${sendPresentation.successfulEvidence.length}; sendReportNA=${sendPresentation.directionNotApplicable.length}; aggregate=${manifest.aggregateSha256})\n`);
