#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-receive-type1-negative-check";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const REVISION = "etherfi-behype-receive-type1-negative-check-r8-r2-reviewer-wording-offline";
const AGENT = "critical-etherfi-behype-r8-wording-20260722";
const CLASSIFICATION = "WATCH/COVERAGE_OPEN/OPTIMISM-RECEIVE-TYPE1-NEGATIVE-SEMANTICS-BOUND/HYPEREVM-UNOBSERVED/NO-BACKEND-INDEPENDENCE-CLAIM";
const QUALIFICATION = "The two agreeing groups are observed hostname-derived provider-family groups; backend/operator independence is not established.";
const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { bytes: body.length, sha256: sha(body) }; };

const raw = JSON.parse(read(RAW)); const manifest = JSON.parse(read(MANIFEST)); const report = read(REPORT); const inbox = JSON.parse(read(INBOX)); const handoff = read(HANDOFF);

assert.strictEqual(raw.schemaVersion, 2);
assert.strictEqual(raw.revision, REVISION);
assert.strictEqual(raw.agentId, AGENT);
assert(raw.runId.startsWith("etherfi-behype-receive-type1-r8-r2-"));
assert.strictEqual(raw.classification, CLASSIFICATION);
assert.strictEqual(raw.providerFamilyQualification, QUALIFICATION);
assert.strictEqual(raw.backendOperatorIndependenceEstablished, false);
assert.strictEqual(raw.backendOperatorIndependenceClaimed, false);
assert.strictEqual(raw.reviewerCorrection.offlineOnly, true);
assert.strictEqual(raw.reviewerCorrection.networkCalls, false);
assert.strictEqual(raw.reviewerCorrection.endpointInventoryReads, false);
assert.strictEqual(raw.reviewerCorrection.evidenceValuesChanged, false);
assert.strictEqual(raw.reviewerCorrection.wordingOnly, true);
assert.strictEqual(raw.safety.endpointInventoriesReadThisRun, false);
assert.strictEqual(raw.safety.networkCalls, false);
assert.strictEqual(raw.safety.offlineCorrection, true);
assert.strictEqual(raw.safety.sourceEvidenceCollectedInPriorAuthorizedReadOnlyRun, true);
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
assert.strictEqual(raw.behavioralConsensusReady, true);
assert.deepStrictEqual(raw.consensus, { codeVersion: 2, config: 2, full: 2, negativeType1: 2, selection: 2, state: 2 });
assert.strictEqual(raw.pin.blockNumber, 154576710);
assert.strictEqual(raw.pin.blockHash, "0xbe73ab02b779223c5a3a47e2d45cc8258c0c264dd82791f9d1e1baec5358e149");
assert.strictEqual(raw.immutablePredecessorR8.runId, "etherfi-behype-receive-type1-r8-65ac73490281d37b3391-501f02f309bb");
assert.strictEqual(raw.immutablePredecessorR8.revision, "etherfi-behype-receive-type1-negative-check-r8-fixed-pin-sanitized");
assert.strictEqual(raw.immutablePredecessorR8.manifest.aggregateSha256, "89666a8dd584c3108231ad4066bd824273802ee6f6ffbf9286a6e4f55575173a");
assert.strictEqual(raw.immutablePredecessorR8.predecessorArtifactsAvailableAfterMutableOverwrite, false);
assert(raw.nextReadOnlyStep.includes("distinct declared/observed HyperEVM provider-family groups"));
assert(!raw.nextReadOnlyStep.includes("independent HyperEVM provider"));

const negative = raw.exemplar.routes.find((route) => route.binding.direction === "receive").receiveType1NegativeCheck;
assert.strictEqual(negative.category, "expected-custom-error");
assert.strictEqual(negative.expected, true);
assert.strictEqual(negative.selector, "0xba97c1fa");
assert.strictEqual(negative.decodedArgument, 1);
assert.strictEqual(negative.strictCustomErrorEncoding, true);
assert.strictEqual(negative.rawRevertDataPersisted, false);
assert.strictEqual(raw.officialLayerZero.exactOfficialRuntimeEquivalence, null);
assert.strictEqual(raw.hyperevm.observedThisRun, false);
assert.strictEqual(raw.gates.routePositive, 0);
assert.strictEqual(raw.gates.executableNow, 0);
assert.strictEqual(raw.gates.signedActionJustified, false);
assert.strictEqual(raw.gates.fork, false);
assert.strictEqual(raw.gates.economicsBlocked, true);

assert.strictEqual(manifest.schemaVersion, 2);
assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(manifest.classification, CLASSIFICATION);
assert.strictEqual(manifest.providerFamilyQualification, QUALIFICATION);
assert.strictEqual(manifest.backendOperatorIndependenceEstablished, false);
assert.strictEqual(manifest.backendOperatorIndependenceClaimed, false);
assert.deepStrictEqual(manifest.consensus, raw.consensus);
assert.deepStrictEqual(manifest.gates, raw.gates);
assert.deepStrictEqual(manifest.immutablePredecessorR8, raw.immutablePredecessorR8);
assert.strictEqual(manifest.safety.endpointInventoriesReadThisRun, false);
assert.strictEqual(manifest.safety.networkCalls, false);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(inbox.agentId, AGENT);
assert.strictEqual(inbox.classification, CLASSIFICATION);
assert.strictEqual(inbox.providerFamilyQualification, QUALIFICATION);
assert.strictEqual(inbox.backendOperatorIndependenceEstablished, false);
assert.strictEqual(inbox.backendOperatorIndependenceClaimed, false);

for (const text of [report, handoff]) assert(text.includes(QUALIFICATION));
assert(report.includes(raw.runId));
assert(report.includes(CLASSIFICATION));
assert(handoff.includes(raw.runId));
assert(handoff.includes(CLASSIFICATION));
const emittedText = [JSON.stringify(raw), JSON.stringify(manifest), JSON.stringify(inbox), report, handoff].join("\n");
assert(!emittedText.includes("independent HyperEVM provider"));
assert(emittedText.includes("distinct declared/observed HyperEVM provider-family groups"));
assert(emittedText.includes(QUALIFICATION));

for (const record of manifest.records) { const current = hashFile(record.path); assert.strictEqual(current.bytes, record.bytes, record.path); assert.strictEqual(current.sha256, record.sha256, record.path); }
assert.strictEqual(sha(Buffer.from(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))), manifest.aggregateSha256);

const published = [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF].map(read).join("\n");
assert(!/(?:https?|wss?):\/\//i.test(published), "scheme leak");
assert(!/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(published), "host leak");
assert(!/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(published), "credential leak");
assert(!/"(?:url|domain|providerName|rawLine|headers?)"\s*:/i.test(published), "endpoint field leak");

process.stdout.write(`PASS EtherFi BeHYPE r8-r2 reviewer wording correction (${raw.runId}; classification=${raw.classification}; independence=false; aggregate=${manifest.aggregateSha256})\n`);
