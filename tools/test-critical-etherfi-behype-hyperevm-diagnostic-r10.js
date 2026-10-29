#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-hyperevm-diagnostic-r10";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const R9_RAW = "reports/raw/fast/critical-etherfi-behype-hyperevm-coverage-r9.json";
const R9_MANIFEST = "reports/raw/fast/critical-etherfi-behype-hyperevm-coverage-r9-manifest.json";
const R8_RAW = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check.json";
const R8_MANIFEST = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check-manifest.json";
const STEP4 = "reports/raw/fast/critical-etherfi-behype-staker-layerzero-binding.json";
const REVISION = "etherfi-behype-hyperevm-diagnostic-r10-substage-partial-evidence";
const AGENT = "critical-etherfi-behype-hyper-diagnostic-r10-20260722";
const CLASSIFICATION = "WATCH/COVERAGE_OPEN/HYPEREVM-DIAGNOSTIC-FAIL-CLOSED/NO-BACKEND-INDEPENDENCE-CLAIM";
const QUALIFICATION = "Observed groups are declared/hostname-derived provider-family groups; backend/operator independence is not established.";
const SUBSTAGES = ["app-runtime", "app-endpoint-peer", "library-selection", "library-runtime", "library-semantics", "applicable-config", "receive-type1-negative", "integration", "anchor", "pin-recheck"];
const STATUS = new Set(["pending", "success", "failed", "blocked", "not-applicable"]);
const ROUTES = new Map([
  ["whype-receive-30111", { direction: "receive", applicableConfigCount: 1 }],
  ["behype-send-30111", { direction: "send", applicableConfigCount: 2 }],
]);

const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };

const raw = JSON.parse(read(RAW));
const manifest = JSON.parse(read(MANIFEST));
const report = read(REPORT);
const inbox = JSON.parse(read(INBOX));
const handoff = read(HANDOFF);

assert.strictEqual(raw.schemaVersion, 1);
assert.strictEqual(raw.revision, REVISION);
assert.strictEqual(raw.scanner, SCANNER);
assert.strictEqual(raw.agentId, AGENT);
assert(raw.runId.startsWith("etherfi-behype-hyperevm-diagnostic-r10-"));
assert.strictEqual(raw.classification, CLASSIFICATION);
assert.strictEqual(raw.providerFamilyQualification, QUALIFICATION);
assert.strictEqual(raw.backendOperatorIndependenceEstablished, false);
assert.strictEqual(raw.backendOperatorIndependenceClaimed, false);
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
assert.deepStrictEqual(raw.failureSubstageEnum, SUBSTAGES);

if (raw.topLevelFailure) {
assert.strictEqual(raw.pin, null);
assert(["official-memory-input", "target-load", "inventory-read", "candidate-probe", "pin-selection", "pin-bind"].includes(raw.topLevelFailure.stage));
assert(raw.failureCategoryEnum.includes(raw.topLevelFailure.category));
assert.strictEqual(raw.topLevelFailure.routeSubstageReached, false);
assert.deepStrictEqual(raw.providers, []);
assert.deepStrictEqual(raw.families, []);
assert.strictEqual(raw.metrics.exactPinProviders, 0);
assert.strictEqual(raw.metrics.exactPinFamilies, 0);
assert.strictEqual(raw.metrics.diagnosedRouteCount, 0);
assert.strictEqual(raw.metrics.completeRouteCount, 0);
assert.strictEqual(raw.gates.hyperRoutesDiagnosticallyComplete, false);
assert.strictEqual(inbox.topLevelFailure.stage, raw.topLevelFailure.stage);
assert(inbox.routeDiagnostics.every((route) => route.topLevelBlocked && route.successfulSubstages.length === 0 && route.firstFailure === null && !route.routeComplete));
} else {
assert(Number.isSafeInteger(raw.pin.blockNumber) && raw.pin.blockNumber > 0);
assert(/^0x[0-9a-f]{64}$/.test(raw.pin.blockHash));
assert(Number.isSafeInteger(raw.pin.timestamp) && raw.pin.timestamp > 0);
assert.strictEqual(raw.pin.crossFamilyFinalityConsensus, false);
assert.strictEqual(raw.pin.crossFamilyHashConsensus, false);
if (raw.metrics.exactPinFamilies === 1 && raw.providers[0]?.provisionalFinality.finalizedSupported) {
  assert.strictEqual(raw.pin.qualification, "sole-family-provisional-reported-finalized-candidate");
}

assert.strictEqual(raw.metrics.authorizedCandidatesTested, raw.metrics.inventoryCandidatesParsed + 1);
assert(raw.metrics.chain999Candidates >= 1);
assert.strictEqual(raw.metrics.exactPinProviders, raw.providers.length);
assert.strictEqual(raw.metrics.exactPinFamilies, raw.families.length);
assert.strictEqual(raw.metrics.diagnosedRouteCount, raw.providers.length * ROUTES.size);
assert.strictEqual(raw.metrics.completeRouteCount, raw.providers.reduce((sum, provider) => sum + provider.completeRouteCount, 0));
assert.strictEqual(raw.routeDefinitionComparison.length, ROUTES.size);
assert.deepStrictEqual(new Set(raw.routeDefinitionComparison.map((row) => row.routeLabel)), new Set(ROUTES.keys()));
for (const comparison of raw.routeDefinitionComparison) {
  assert(/^[0-9a-f]{64}$/.test(comparison.routeIdentityDigest));
  assert.strictEqual(typeof comparison.step4IdentityComparison.match, "boolean");
  for (const key of ["appMatches", "eidMatches", "directionMatches", "configTypesMatch"]) assert.strictEqual(typeof comparison.step4IdentityComparison[key], "boolean");
}

for (const provider of raw.providers) {
  assert(/^hyperevm-provider-\d{2}$/.test(provider.providerId));
  assert(/^hyperevm-family-\d{2}$/.test(provider.familyId));
  assert(["declared-official-public", "observed-inventory"].includes(provider.familyClass));
  assert.strictEqual(provider.noIdentifiersPersisted, true);
  assert.strictEqual(provider.routes.length, ROUTES.size);
  assert.deepStrictEqual(new Set(provider.routes.map((route) => route.routeLabel)), new Set(ROUTES.keys()));
  assert.strictEqual(provider.completeRouteCount, provider.routes.filter((route) => route.routeComplete).length);
  assert.strictEqual(provider.allRoutesComplete, provider.routes.every((route) => route.routeComplete));
  assert.strictEqual(typeof provider.provisionalFinality.finalizedSupported, "boolean");
  if (provider.provisionalFinality.finalizedSupported) assert.strictEqual(typeof provider.provisionalFinality.finalizedHeightAtLeastPin, "boolean");
  else assert.strictEqual(provider.provisionalFinality.finalizedHeightAtLeastPin, null);

  for (const route of provider.routes) {
    const expected = ROUTES.get(route.routeLabel); assert(expected, route.routeLabel);
    assert(/^[0-9a-f]{64}$/.test(route.routeIdentityDigest));
    assert.deepStrictEqual(route.configuredFieldLabels, ["app", "remoteEid", "direction", "applicableConfigTypes"]);
    assert.deepStrictEqual(route.substageOrder, SUBSTAGES);
    assert.strictEqual(route.noRawResponsesPersisted, true);
    assert.strictEqual(route.noAddressesPersisted, true);
    assert.deepStrictEqual(Object.keys(route.checks).sort(), [...SUBSTAGES].sort());

    const successful = [];
    const failed = [];
    for (const substage of SUBSTAGES) {
      const check = route.checks[substage];
      assert.strictEqual(check.substage, substage);
      assert(STATUS.has(check.status), `${route.routeLabel}/${substage}/${check.status}`);
      assert.notStrictEqual(check.status, "pending");
      assert.strictEqual(typeof check.category, "string");
      assert(Number.isSafeInteger(check.successfulBooleanCount) && check.successfulBooleanCount >= 0);
      assert.strictEqual(check.successfulBooleanCount, Object.entries(check).filter(([key, value]) => !["digests"].includes(key) && value === true).length);
      assert(Number.isSafeInteger(check.digestCount) && check.digestCount >= 0);
      assert(check.digests && typeof check.digests === "object" && !Array.isArray(check.digests));
      assert.strictEqual(check.digestCount, Object.keys(check.digests).length);
      for (const value of Object.values(check.digests)) assert(/^(?:0x)?[0-9a-f]{64}$/.test(value));
      if (check.status === "success" || check.status === "not-applicable") successful.push(substage);
      if (check.status === "failed") { failed.push(substage); assert(raw.failureCategoryEnum.includes(check.category), check.category); }
    }
    assert.deepStrictEqual(route.successfulSubstages, successful);
    assert.strictEqual(route.successfulSubstageCount, successful.length);
    assert.strictEqual(route.failedSubstageCount, failed.length);
    assert.deepStrictEqual(route.firstFailure, failed.length ? { failureSubstage: failed[0], failureCategory: route.checks[failed[0]].category } : null);
    const expectedComplete = SUBSTAGES.every((substage) => route.checks[substage].status === "success" || substage === "receive-type1-negative" && expected.direction === "send" && route.checks[substage].status === "not-applicable");
    assert.strictEqual(route.routeComplete, expectedComplete);

    const negative = route.checks["receive-type1-negative"];
    if (expected.direction === "send") {
      assert.strictEqual(negative.status, "not-applicable");
      assert.strictEqual(negative.category, "direction-not-applicable");
    } else if (negative.status === "success") {
      assert.strictEqual(negative.category, "expected-custom-error");
      assert.strictEqual(negative.selectorMatches, true);
      assert.strictEqual(negative.argumentMatches, true);
      assert.strictEqual(negative.strictEncoding, true);
      assert.strictEqual(negative.revertDataBytes, 36);
    }
    const configs = route.checks["applicable-config"];
    if (configs.status === "success") {
      assert.strictEqual(configs.expectedConfigCount, expected.applicableConfigCount);
      assert.strictEqual(configs.successfulConfigCount, expected.applicableConfigCount);
      assert.strictEqual(configs.configRows.length, expected.applicableConfigCount);
      assert(configs.configRows.every((row) => row.status === "success"));
    }
  }
}

for (const family of raw.families) {
  assert(/^hyperevm-family-\d{2}$/.test(family.familyId));
  assert(["declared-official-public", "observed-inventory"].includes(family.familyClass));
  const rows = raw.providers.filter((provider) => provider.familyId === family.familyId);
  assert.strictEqual(family.providerCount, rows.length);
  assert.strictEqual(family.routeCompleteCount, rows.reduce((sum, provider) => sum + provider.completeRouteCount, 0));
  assert.strictEqual(family.complete, rows.every((provider) => provider.routes.every((route) => route.routeComplete)));
}
}

assert.strictEqual(raw.gates.routePositive, 0);
assert.strictEqual(raw.gates.executableNow, 0);
assert.strictEqual(raw.gates.signedActionJustified, false);
assert.strictEqual(raw.gates.fork, false);
assert.strictEqual(raw.gates.hyperRoutesDiagnosticallyComplete, raw.providers.length > 0 && raw.providers.every((provider) => provider.allRoutesComplete));
assert.strictEqual(raw.gates.crossFamilyConsensus, false);
assert.strictEqual(raw.gates.reviewedTwoChainConsensus, false);
assert.strictEqual(raw.gates.economicsBlocked, true);
if (raw.gates.hyperRoutesDiagnosticallyComplete) assert(raw.nextReadOnlyStep.startsWith("Obtain a second distinct declared/observed usable HyperEVM provider-family group"));
assert.strictEqual(raw.safety.readOnly, true);
assert.strictEqual(raw.safety.currentInvocationBoundedPass, true);
if (raw.safety.explicitCorrectedRetryAuthorized) {
  assert.strictEqual(raw.safety.oneBoundedPass, false);
  assert.strictEqual(raw.safety.repeatedRetries, true);
  assert.strictEqual(raw.safety.boundedPassCount, 2);
  assert.strictEqual(raw.safety.priorFailedPassCount, 1);
} else {
  assert.strictEqual(raw.safety.oneBoundedPass, true);
  assert.strictEqual(raw.safety.repeatedRetries, false);
  assert.strictEqual(raw.safety.boundedPassCount, 1);
  assert.strictEqual(raw.safety.priorFailedPassCount, 0);
}
assert.strictEqual(raw.safety.officialEndpointFromProcessMemory, true);
assert.strictEqual(raw.safety.rpcInventoryRead, true);
for (const key of ["rawResponsesPersisted", "targetAddressesPersisted", "endpointIdentifiersPersisted", "providerNamesPersisted", "providerDomainsPersisted", "keysPersisted", "headersPersisted", "rawInventoryLinesPersisted", "economicsCalls", "transactions", "stakeCalls", "messageSendCalls", "protocolRetryCalls", "sweepCalls", "signing", "forkCreated", "mutation"]) assert.strictEqual(raw.safety[key], false, key);

for (const predecessor of [[raw.immutablePredecessorR9, R9_RAW, R9_MANIFEST], [raw.immutablePredecessorR8, R8_RAW, R8_MANIFEST]]) {
  assert.strictEqual(predecessor[0].raw.path, predecessor[1]);
  assert.strictEqual(predecessor[0].manifest.path, predecessor[2]);
  assert.deepStrictEqual(predecessor[0].raw, hashFile(predecessor[1]));
  assert.deepStrictEqual(predecessor[0].manifest, hashFile(predecessor[2]));
}
assert.strictEqual(raw.retainedStep4Binding.artifact.path, STEP4);
assert.deepStrictEqual(raw.retainedStep4Binding.artifact, hashFile(STEP4));
assert.strictEqual(raw.retainedStep4Binding.rawAddressesPersistedInR10, false);

assert.strictEqual(manifest.schemaVersion, 1);
assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(manifest.classification, CLASSIFICATION);
assert.strictEqual(manifest.providerFamilyQualification, QUALIFICATION);
assert.strictEqual(manifest.backendOperatorIndependenceEstablished, false);
assert.strictEqual(manifest.backendOperatorIndependenceClaimed, false);
assert.deepStrictEqual(manifest.pin, raw.pin);
assert.deepStrictEqual(manifest.metrics, raw.metrics);
assert.deepStrictEqual(manifest.gates, raw.gates);
assert.deepStrictEqual(manifest.safety, raw.safety);
assert.deepStrictEqual(manifest.routeDiagnostics, inbox.routeDiagnostics);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(inbox.agentId, AGENT);
assert.strictEqual(inbox.classification, CLASSIFICATION);
assert.strictEqual(inbox.providerFamilyQualification, QUALIFICATION);
assert.strictEqual(inbox.routePositive, 0);
assert.strictEqual(inbox.executableNow, 0);
assert.strictEqual(inbox.signedActionJustified, false);
assert.strictEqual(inbox.fork, false);
assert(report.includes(raw.runId));
assert(report.includes(QUALIFICATION));
if (raw.topLevelFailure) assert(report.includes("stopped before pin binding"));
else if (raw.pin.qualification === "sole-family-provisional-reported-finalized-candidate") assert(report.includes("sole-family provisional reported-finalized candidate"));
else assert(report.includes("provisional numeric candidate"));
assert(handoff.includes(raw.runId));
assert(handoff.includes(QUALIFICATION));

for (const record of manifest.records) assert.deepStrictEqual(record, hashFile(record.path), record.path);
assert.strictEqual(sha(Buffer.from(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))), manifest.aggregateSha256);

for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) {
  const published = read(rel);
  assert(!/(?:https?|wss?):\/\//i.test(published), `scheme leak ${rel}`);
  const hostLeak = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.exec(published);
  assert(!hostLeak, `host leak ${rel}:${hostLeak ? published.slice(0, hostLeak.index).split("\n").length : 0}`);
  assert(!/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(published), `credential leak ${rel}`);
  assert(!/"(?:url|domain|providerName|rawLine|headers?|address)"\s*:/i.test(published), `identifier field leak ${rel}`);
}
const generated = [RAW, MANIFEST, REPORT, INBOX, HANDOFF].map(read).join("\n");
assert(!/0x[0-9a-f]{40}(?![0-9a-f])/i.test(generated), "target address leak");

process.stdout.write(`PASS EtherFi BeHYPE HyperEVM R10 (${raw.runId}; pin=${raw.pin?.blockNumber ?? "unavailable"}; families=${raw.metrics.exactPinFamilies}; routes=${raw.metrics.diagnosedRouteCount}; complete=${raw.metrics.completeRouteCount}; aggregate=${manifest.aggregateSha256})\n`);
