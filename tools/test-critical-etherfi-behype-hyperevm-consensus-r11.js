#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-hyperevm-consensus-r11";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const R10R2_RAW = "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10-r2.json";
const R10R2_MANIFEST = "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10-r2-manifest.json";
const R8_RAW = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check.json";
const R8_MANIFEST = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check-manifest.json";
const R10_SCANNER = "tools/scan-critical-etherfi-behype-hyperevm-diagnostic-r10.js";
const REVISION = "etherfi-behype-hyperevm-consensus-r11-multifamily-archive-full-tuple";
const AGENT = "critical-etherfi-behype-hyper-consensus-r11-20260722";
const QUALIFICATION = "Distinct declared/observed provider-family groups are anonymous hostname-derived groups; backend/operator independence is not established.";
const SUBSTAGES = ["app-runtime", "app-endpoint-peer", "library-selection", "library-runtime", "library-semantics", "applicable-config", "receive-type1-negative", "integration", "anchor", "pin-recheck"];

const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };

const raw = readJson(RAW); const manifest = readJson(MANIFEST); const report = read(REPORT); const inbox = readJson(INBOX); const handoff = read(HANDOFF); const r10 = readJson(R10R2_RAW); const r8 = readJson(R8_RAW);

assert.strictEqual(raw.schemaVersion, 1);
assert.strictEqual(raw.revision, REVISION);
assert.strictEqual(raw.scanner, SCANNER);
assert.strictEqual(raw.agentId, AGENT);
assert(raw.runId.startsWith("etherfi-behype-hyperevm-consensus-r11-"));
assert(["WATCH/COVERAGE_READY/HYPEREVM-MULTI-FAMILY-FULL-BEHAVIORAL-CONSENSUS/PROVISIONAL-FINALITY/NO-BACKEND-INDEPENDENCE-CLAIM", "WATCH/COVERAGE_OPEN/HYPEREVM-FAMILY-THRESHOLD-NOT-MET/PROVISIONAL-FINALITY/NO-BACKEND-INDEPENDENCE-CLAIM"].includes(raw.classification));
assert.strictEqual(raw.providerFamilyQualification, QUALIFICATION);
assert.strictEqual(raw.backendOperatorIndependenceEstablished, false);
assert.strictEqual(raw.backendOperatorIndependenceClaimed, false);
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);

assert(Number.isSafeInteger(raw.pin.blockNumber) && raw.pin.blockNumber > r10.pin.blockNumber);
assert(/^0x[0-9a-f]{64}$/.test(raw.pin.blockHash));
assert.strictEqual(raw.pin.exactPinFamilyCount, raw.metrics.exactPinFamilies);
assert.strictEqual(raw.pin.crossFamilyHashAgreement, raw.metrics.exactPinFamilies >= 2);
assert(raw.metrics.exactPinFamilies >= 2, "fresh pin must be supported by multiple families");
assert(raw.metrics.rpcCandidatesTested >= raw.metrics.matrixArchiveCandidates);
assert(raw.metrics.chain999Candidates >= raw.metrics.identityQualifiedCandidates);
assert(raw.metrics.exactPinCandidates >= raw.metrics.exactPinFamilies);
assert.strictEqual(raw.metrics.archiveQualifiedFamilies, raw.families.filter((row) => row.archiveQualified).length);
assert.strictEqual(raw.metrics.finalizedFamiliesAtPin, raw.families.filter((row) => row.finalizedAtPin).length);
assert.strictEqual(raw.metrics.retainedHashOnlyFamilies, raw.families.filter((row) => row.complete && !row.finalizedAtPin && row.retainedHashStable).length);
assert.strictEqual(raw.metrics.fullFamilies, raw.families.filter((row) => row.complete).length);
assert.strictEqual(raw.qualificationMatrix.entriesMatched, raw.metrics.matrixArchiveCandidates);
assert(/^[0-9a-f]{64}$/.test(raw.qualificationMatrix.digest));
assert.strictEqual(raw.qualificationMatrix.rawMatrixPersisted, false);

function routeDigest(route, includeAnchor) {
  const checks = {};
  for (const name of route.substageOrder) { if (!includeAnchor && ["anchor", "pin-recheck"].includes(name)) continue; const check = route.checks[name]; checks[name] = { status: check.status, category: check.category, digests: check.digests, successfulBooleanCount: check.successfulBooleanCount, digestCount: check.digestCount, configRows: check.configRows || null }; }
  return digest({ routeLabel: route.routeLabel, routeIdentityDigest: route.routeIdentityDigest, checks });
}

for (const family of raw.families) {
  assert(/^hyperevm-family-\d{2,3}$/.test(family.familyId));
  assert(["declared-archive-matrix", "observed-prior-inventory"].includes(family.familyClass));
  assert(Number.isSafeInteger(family.candidateCount) && family.candidateCount >= 1);
  assert(!Object.keys(family).some((key) => /url|domain|provider|endpoint|header|key/i.test(key)), "family identifier field");
  if (!family.complete) continue;
  assert.strictEqual(family.ambiguousWithinFamily, false);
  assert.strictEqual(family.routes.length, 2);
  assert.strictEqual(family.routes.every((route) => route.routeComplete), true);
  const receive = family.routes.find((route) => route.routeLabel === "whype-receive-30111"); const send = family.routes.find((route) => route.routeLabel === "behype-send-30111"); assert(receive && send);
  for (const route of family.routes) { assert.deepStrictEqual(route.substageOrder, SUBSTAGES); assert.strictEqual(route.checks["pin-recheck"].status, "success"); assert.strictEqual(route.checks.anchor.status, "success"); }
  assert.strictEqual(receive.checks["receive-type1-negative"].status, "success");
  assert.strictEqual(receive.checks["receive-type1-negative"].category, "expected-custom-error");
  assert.strictEqual(send.checks["receive-type1-negative"].status, "not-applicable");
  assert.strictEqual(send.checks["receive-type1-negative"].category, "direction-not-applicable");
  const behavior = digest(family.routes.map((route) => routeDigest(route, false))); const anchor = digest(family.routes.map((route) => route.checks.anchor.digests.anchorDigest || null));
  assert.strictEqual(family.behavioralTupleDigest, behavior); assert.strictEqual(family.anchorDigest, anchor); assert.strictEqual(family.fullTupleAnchorDigest, digest({ behavioralTupleDigest: behavior, anchorDigest: anchor }));
}

const groups = new Map(); for (const family of raw.families.filter((row) => row.complete)) { const set = groups.get(family.fullTupleAnchorDigest) || new Set(); set.add(family.familyId); groups.set(family.fullTupleAnchorDigest, set); }
const consensusFamilies = Math.max(0, ...[...groups.values()].map((set) => set.size));
assert.strictEqual(raw.metrics.consensusFamilies, consensusFamilies);
assert.strictEqual(raw.canonicalConsensus.familyCount, consensusFamilies);
assert.strictEqual(raw.canonicalConsensus.thresholdMet, consensusFamilies >= 2);
assert.strictEqual(raw.canonicalConsensus.preferredThresholdMet, consensusFamilies >= 3);
if (consensusFamilies) assert.strictEqual(groups.get(raw.canonicalConsensus.fullTupleAnchorDigest).size, consensusFamilies);
assert.strictEqual(raw.coverage.hyperEvmThresholdReady, consensusFamilies >= 2);
assert.strictEqual(raw.coverage.optimismPredecessorReady, r8.behavioralConsensusReady === true && r8.consensus.full >= 2);
assert.strictEqual(raw.coverage.twoChainCoverageReady, raw.coverage.hyperEvmThresholdReady && raw.coverage.optimismPredecessorReady);
assert.strictEqual(raw.coverage.economicsModelReviewEligible, raw.coverage.twoChainCoverageReady);
assert.strictEqual(raw.coverage.economicsPerformed, false);
assert.strictEqual(raw.classification.includes("COVERAGE_READY"), raw.coverage.hyperEvmThresholdReady);

assert.strictEqual(raw.graphqlProtocolProbe.usedForFinalityOrStateConsensus, false);
assert.strictEqual(raw.graphqlProtocolProbe.candidatesTested, raw.metrics.graphqlCandidatesTested);
assert.strictEqual(raw.graphqlProtocolProbe.protocolResponses, raw.metrics.graphqlProtocolResponses);
for (const row of raw.excludedCategories) { assert(Number.isSafeInteger(row.count) && row.count > 0); assert.strictEqual(typeof row.substage, "string"); assert.strictEqual(typeof row.category, "string"); }

assert.deepStrictEqual(raw.immutablePredecessorR10R2.raw, hashFile(R10R2_RAW));
assert.deepStrictEqual(raw.immutablePredecessorR10R2.manifest, hashFile(R10R2_MANIFEST));
assert.strictEqual(raw.immutablePredecessorR10R2.runId, r10.runId);
assert.deepStrictEqual(raw.immutablePredecessorR8R2.raw, hashFile(R8_RAW));
assert.deepStrictEqual(raw.immutablePredecessorR8R2.manifest, hashFile(R8_MANIFEST));
assert.strictEqual(raw.immutablePredecessorR8R2.runId, r8.runId);
assert.deepStrictEqual(raw.retainedR10Scanner, hashFile(R10_SCANNER));

assert.strictEqual(raw.gates.routePositive, 0); assert.strictEqual(raw.gates.executableNow, 0); assert.strictEqual(raw.gates.signedActionJustified, false); assert.strictEqual(raw.gates.fork, false); assert.strictEqual(raw.gates.twoChainCoverageReady, raw.coverage.twoChainCoverageReady); assert.strictEqual(raw.gates.economicsBlockedPendingSeparateReview, true);
assert.strictEqual(raw.safety.readOnly, true); assert.strictEqual(raw.safety.boundedPass, true); assert.strictEqual(raw.safety.boundedRetryCount, 1); assert.strictEqual(raw.safety.priorIncompleteRunReconciled, true); assert.strictEqual(raw.safety.serverSideRequests, true); assert.strictEqual(raw.safety.individualCallsUsed, true); assert.strictEqual(raw.safety.batchOnlyDependency, false);
for (const key of ["rawResponsesPersisted", "rawInventoryLinesPersisted", "endpointIdentifiersPersisted", "providerNamesPersisted", "providerDomainsPersisted", "keysPersisted", "headersPersisted", "economicsCalls", "transactions", "stakeCalls", "messageSendCalls", "protocolRetryCalls", "sweepCalls", "signing", "forkCreated", "mutation"]) assert.strictEqual(raw.safety[key], false, key);

assert.strictEqual(manifest.schemaVersion, 1); assert.strictEqual(manifest.revision, REVISION); assert.strictEqual(manifest.runId, raw.runId); assert.strictEqual(manifest.classification, raw.classification); assert.deepStrictEqual(manifest.pin, raw.pin); assert.deepStrictEqual(manifest.metrics, raw.metrics); assert.deepStrictEqual(manifest.canonicalConsensus, raw.canonicalConsensus); assert.deepStrictEqual(manifest.coverage, raw.coverage); assert.deepStrictEqual(manifest.excludedCategories, raw.excludedCategories); assert.deepStrictEqual(manifest.gates, raw.gates); assert.deepStrictEqual(manifest.safety, raw.safety);
assert.strictEqual(inbox.runId, raw.runId); assert.strictEqual(inbox.agentId, AGENT); assert.strictEqual(inbox.classification, raw.classification); assert.deepStrictEqual(inbox.metrics, raw.metrics); assert.deepStrictEqual(inbox.coverage, raw.coverage); assert.strictEqual(inbox.routePositive, 0); assert.strictEqual(inbox.executableNow, 0); assert.strictEqual(inbox.signedActionJustified, false); assert.strictEqual(inbox.fork, false);
assert(report.includes(raw.runId)); assert(report.includes(raw.classification)); assert(report.includes(QUALIFICATION)); assert(handoff.includes(raw.runId)); assert(handoff.includes(raw.classification)); assert(handoff.includes(QUALIFICATION));

for (const record of manifest.records) assert.deepStrictEqual(record, hashFile(record.path), record.path);
assert.strictEqual(sha(Buffer.from(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))), manifest.aggregateSha256);
for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) {
  const published = read(rel); assert(!/(?:https?|wss?):\/\//i.test(published), `scheme leak ${rel}`); assert(!/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(published), `host leak ${rel}`); assert(!/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(published), `credential leak ${rel}`); assert(!/"(?:url|domain|providerName|rawLine|headers?|address|endpointId|endpointIdentifier)"\s*:/i.test(published), `identifier field leak ${rel}`);
}
const generated = [RAW, MANIFEST, REPORT, INBOX, HANDOFF].map(read).join("\n"); assert(!/0x[0-9a-f]{40}(?![0-9a-f])/i.test(generated), "target address leak");

process.stdout.write(`PASS EtherFi BeHYPE HyperEVM R11 (${raw.runId}; candidates=${raw.metrics.rpcCandidatesTested}; archiveFamilies=${raw.metrics.archiveQualifiedFamilies}; finalizedFamilies=${raw.metrics.finalizedFamiliesAtPin}; fullFamilies=${raw.metrics.fullFamilies}; consensusFamilies=${raw.metrics.consensusFamilies}; ready=${raw.coverage.twoChainCoverageReady}; aggregate=${manifest.aggregateSha256})\n`);
