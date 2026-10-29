#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-hyperevm-coverage-r9";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const R8_RAW = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check.json";
const R8_MANIFEST = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check-manifest.json";
const REVISION = "etherfi-behype-hyperevm-coverage-r9-fresh-conservative-pin";
const AGENT = "critical-etherfi-behype-hyper-coverage-r9-20260722";
const QUALIFICATION = "Agreeing groups are distinct declared/observed provider-family groups; backend/operator independence is not established.";
const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { bytes: body.length, sha256: sha(body) }; };

const raw = JSON.parse(read(RAW)); const manifest = JSON.parse(read(MANIFEST)); const report = read(REPORT); const inbox = JSON.parse(read(INBOX)); const handoff = read(HANDOFF);

assert.strictEqual(raw.schemaVersion, 1);
assert.strictEqual(raw.revision, REVISION);
assert.strictEqual(raw.agentId, AGENT);
assert(raw.runId.startsWith("etherfi-behype-hyperevm-r9-"));
assert(raw.classification.startsWith("WATCH/"));
assert.strictEqual(raw.providerFamilyQualification, QUALIFICATION);
assert.strictEqual(raw.backendOperatorIndependenceEstablished, false);
assert.strictEqual(raw.backendOperatorIndependenceClaimed, false);
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
assert(Number.isSafeInteger(raw.pin.blockNumber));
assert(/^0x[0-9a-f]{64}$/.test(raw.pin.blockHash));
assert(raw.pin.conservativeDepthWhenFinalizedUnsupported === 8);
assert.strictEqual(raw.pin.retainedHashStableAcrossCompleteFamilies, raw.providers.some((row) => row.complete) && raw.providers.filter((row) => row.complete).every((row) => row.retainedHashStable));
assert.strictEqual(raw.pin.finalizedClaimedForAllFamilies, raw.families.some((row) => row.complete) && raw.families.filter((row) => row.complete).every((row) => row.finalityModes.every((mode) => mode === "reported-finalized-height-bound")));
assert.strictEqual(raw.metrics.authorizedCandidatesTested, raw.metrics.inventoryCandidatesParsed + 1);
assert(raw.metrics.chain999Candidates >= 1);
assert(raw.metrics.chain999ObservedFamilies >= 1);
assert(raw.metrics.exactPinFamilies >= 1);
assert.strictEqual(raw.metrics.exactPinProviders, raw.providers.length);
assert.strictEqual(raw.metrics.completeProviders, raw.providers.filter((row) => row.complete).length);
assert.strictEqual(raw.metrics.completeFamilies, raw.families.filter((row) => row.complete).length);
assert.strictEqual(raw.officialFamilyBinding.familyClass, "declared-official-public");
assert.strictEqual(raw.officialFamilyBinding.endpointIdentifierPersisted, false);
assert.strictEqual(raw.officialFamilyBinding.officialDocsIdentificationProvidedByUser, true);
assert.strictEqual(raw.inventoryFamilyBinding.familyClass, "observed-inventory");
assert.strictEqual(raw.inventoryFamilyBinding.endpointIdentifiersPersisted, false);
assert.strictEqual(raw.immutablePredecessorR8.raw.path, R8_RAW);
assert.strictEqual(raw.immutablePredecessorR8.manifest.path, R8_MANIFEST);
assert.strictEqual(raw.officialLayerZero.exactOfficialRuntimeEquivalence, null);
assert.strictEqual(raw.officialLayerZero.qualification, "behavioral binding only");
assert.strictEqual(raw.finalitySummary.noUniversalFinalityClaim, true);

const expectedRoutes = {
  "hyperevm-whype-receive-30111": { direction: "receive", eid: 30111, configs: [2], type: new Set(["Receive", "SendAndReceive"]) },
  "hyperevm-behype-send-30111": { direction: "send", eid: 30111, configs: [1, 2], type: new Set(["Send", "SendAndReceive"]) },
};
assert.strictEqual(raw.routeDefinitions.length, 2);
for (const definition of raw.routeDefinitions) {
  const expected = expectedRoutes[definition.id]; assert(expected);
  assert.strictEqual(definition.direction, expected.direction);
  assert.strictEqual(definition.remoteEid, expected.eid);
  assert.deepStrictEqual(definition.applicableConfigTypes, expected.configs);
}

for (const provider of raw.providers) {
  assert(/^hyperevm-provider-\d{2}$/.test(provider.providerId));
  assert(/^hyperevm-family-\d{2}$/.test(provider.familyId));
  assert(["declared-official-public", "observed-inventory"].includes(provider.familyClass));
  if (!provider.complete) continue;
  assert.strictEqual(provider.retainedHashStable, true);
  assert(provider.finalityQualification);
  if (provider.finalityQualification.finalizedSupported) {
    assert.strictEqual(provider.finalityQualification.mode, "reported-finalized-height-bound");
    assert.strictEqual(provider.finalityQualification.finalizedHeightAtLeastPin, true);
  } else {
    assert.strictEqual(provider.finalityQualification.mode, "finalized-unsupported/retained-hash-stability-only");
    assert.strictEqual(provider.finalityQualification.finalizedHeightAtLeastPin, null);
  }
  assert(provider.anchorWindow.blockCount <= 50);
  assert.strictEqual(provider.anchorWindow.toBlock, raw.pin.blockNumber);
  assert.strictEqual(provider.anchorWindow.rawLogsPersisted, false);
  assert.strictEqual(provider.routes.length, 2);
  for (const route of provider.routes) {
    const expected = expectedRoutes[route.routeId]; assert(expected);
    assert.strictEqual(route.binding.direction, expected.direction);
    assert.strictEqual(route.binding.remoteEid, expected.eid);
    assert.strictEqual(route.binding.appEndpointMatches, true);
    assert.strictEqual(route.binding.peerNonzero, true);
    assert(/^0x[0-9a-f]{40}$/.test(route.selection.selectedLibrary));
    assert.deepStrictEqual(route.selection.returnShape, ["address", "bool"]);
    assert.strictEqual(route.selection.strictDecoded, true);
    assert.strictEqual(route.appState.proxy.proxyAmbiguous, false);
    assert.strictEqual(route.selectedLibraryState.proxy.proxyAmbiguous, false);
    assert(expected.type.has(route.semantics.messageLibType));
    assert.deepStrictEqual(route.semantics.version, { endpointVersion: 2, major: "3", minor: 0 });
    assert.strictEqual(route.semantics.supportedEid, true);
    assert.strictEqual(route.semantics.registeredAtEndpoint, true);
    assert.strictEqual(route.semantics.directionMatches, true);
    assert.strictEqual(route.semantics.versionMatches, true);
    assert.strictEqual(route.semantics.exactOfficialRuntimeEquivalence, null);
    assert.deepStrictEqual(route.applicableConfigs.map((row) => row.configType), expected.configs);
    for (const config of route.applicableConfigs) {
      assert.strictEqual(config.strictEnvelopeDecode, true);
      assert.strictEqual(config.strictPayloadDecode, true);
      assert.strictEqual(config.rawEnvelopePersisted, false);
      assert.strictEqual(config.rawPayloadPersisted, false);
      assert(/^0x[0-9a-f]{64}$/.test(config.rawEnvelopeDigest));
      assert(/^0x[0-9a-f]{64}$/.test(config.payloadDigest));
      assert(/^[0-9a-f]{64}$/.test(config.decodedEffectiveSchemaDigest));
    }
    if (route.binding.direction === "receive") {
      const negative = route.receiveType1NegativeCheck;
      assert.strictEqual(negative.category, "expected-custom-error");
      assert.strictEqual(negative.expected, true);
      assert.strictEqual(negative.revertDataBytes, 36);
      assert.strictEqual(negative.selector, "0xba97c1fa");
      assert.strictEqual(negative.decodedArgument, 1);
      assert.strictEqual(negative.strictCustomErrorEncoding, true);
      assert.strictEqual(negative.rawRevertDataPersisted, false);
    } else assert.strictEqual(route.receiveType1NegativeCheck, null);
  }
  assert(provider.integration);
  assert.strictEqual(provider.integration.adapters.length, 2);
  assert(/^[0-9a-f]{64}$/.test(provider.integration.digest));
  for (const adapter of provider.integration.adapters) {
    assert(/^0x[0-9a-f]{40}$/.test(adapter.token));
    assert(/^0x[0-9a-f]{64}$/.test(adapter.tokenCodeHash));
    assert(/^\d+$/.test(adapter.receiverTokenBalance));
    assert(/^\d+$/.test(adapter.adapterTokenBalance));
    assert(/^\d+$/.test(adapter.receiverAllowanceToAdapter));
  }
}

for (const family of raw.families) {
  assert(/^hyperevm-family-\d{2}$/.test(family.familyId));
  assert(["declared-official-public", "observed-inventory"].includes(family.familyClass));
  if (family.complete) assert(Object.values(family.equality).every(Boolean));
}

function consensus(keys) {
  const groups = new Map();
  for (const family of raw.families.filter((row) => row.complete)) { const key = keys.map((item) => item === "anchor" ? family.anchorDigest : family.tuple[item]).join(":"); const set = groups.get(key) || new Set(); set.add(family.familyId); groups.set(key, set); }
  return Math.max(0, ...[...groups.values()].map((set) => set.size));
}
assert.strictEqual(raw.consensus.selection, consensus(["selection", "anchor"]));
assert.strictEqual(raw.consensus.codeVersion, consensus(["codeVersion", "anchor"]));
assert.strictEqual(raw.consensus.config, consensus(["config", "anchor"]));
assert.strictEqual(raw.consensus.integration, consensus(["integration", "anchor"]));
assert.strictEqual(raw.consensus.state, consensus(["state", "anchor"]));
assert.strictEqual(raw.consensus.negativeType1, consensus(["negativeType1", "anchor"]));
assert.strictEqual(raw.consensus.full, consensus(["selection", "codeVersion", "config", "integration", "state", "negativeType1", "anchor"]));
assert.strictEqual(raw.coverageReady, raw.consensus.full >= 2);
assert.strictEqual(raw.gates.hyperevmTwoGroupBehavioralConsensus, raw.coverageReady);
assert.strictEqual(raw.gates.optimismPredecessorBehavioralConsensus, true);
assert.strictEqual(raw.gates.reviewedTwoChainConsensus, false);
assert.strictEqual(raw.gates.economicsBlocked, true);
assert.strictEqual(raw.gates.routePositive, 0);
assert.strictEqual(raw.gates.executableNow, 0);
assert.strictEqual(raw.gates.signedActionJustified, false);
assert.strictEqual(raw.gates.fork, false);
if (raw.coverageReady) assert(raw.classification.includes("TWO-GROUP-HYPEREVM-BEHAVIORAL-CONSENSUS"));
else {
  assert(raw.classification.includes("FAMILY-THRESHOLD-NOT-MET"));
  assert(raw.nextReadOnlyStep.includes("second distinct declared/observed usable HyperEVM provider-family group"));
  assert(["authenticated-inventory-candidate-observed-but-archive-family-unusable-or-incomplete", "authenticated-archive-family-absent-or-unusable-in-authorized-inventory", "observed-authenticated-archive-family-usable"].includes(raw.authenticatedArchiveFamilyStatus));
}

assert.strictEqual(raw.safety.readOnly, true);
assert.strictEqual(raw.safety.officialEndpointUsedFromProcessMemory, true);
assert.strictEqual(raw.safety.rpcInventoryRead, true);
for (const key of ["endpointIdentifiersPersisted", "providerNamesPersisted", "providerDomainsPersisted", "keysPersisted", "headersPersisted", "rawInventoryLinesPersisted", "economicsCalls", "transactions", "stakeCalls", "messageSendCalls", "retryCalls", "sweepCalls", "signing", "forkCreated", "mutation"]) assert.strictEqual(raw.safety[key], false, key);

assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(manifest.classification, raw.classification);
assert.strictEqual(manifest.providerFamilyQualification, QUALIFICATION);
assert.strictEqual(manifest.backendOperatorIndependenceEstablished, false);
assert.strictEqual(manifest.backendOperatorIndependenceClaimed, false);
assert.deepStrictEqual(manifest.pin, raw.pin);
assert.deepStrictEqual(manifest.consensus, raw.consensus);
assert.deepStrictEqual(manifest.gates, raw.gates);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(inbox.agentId, AGENT);
assert.strictEqual(inbox.providerFamilyQualification, QUALIFICATION);
assert.strictEqual(inbox.backendOperatorIndependenceEstablished, false);
assert.strictEqual(inbox.backendOperatorIndependenceClaimed, false);
assert(report.includes(raw.runId));
assert(report.includes(QUALIFICATION));
assert(handoff.includes(raw.runId));
assert(handoff.includes(QUALIFICATION));

for (const record of manifest.records) { const current = hashFile(record.path); assert.strictEqual(current.bytes, record.bytes, record.path); assert.strictEqual(current.sha256, record.sha256, record.path); }
assert.strictEqual(sha(Buffer.from(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))), manifest.aggregateSha256);

const published = [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF].map(read).join("\n");
assert(!/(?:https?|wss?):\/\//i.test(published), "scheme leak");
assert(!/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(published), "host leak");
assert(!/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(published), "credential leak");
assert(!/"(?:url|domain|providerName|rawLine|headers?)"\s*:/i.test(published), "endpoint field leak");

process.stdout.write(`PASS EtherFi BeHYPE HyperEVM R9 (${raw.runId}; pin=${raw.pin.blockNumber}; groups=${raw.metrics.exactPinFamilies}/${raw.metrics.completeFamilies}; finality=${raw.finalitySummary.reportedFinalizedCompleteFamilies}/${raw.finalitySummary.retainedHashOnlyCompleteFamilies}; full=${raw.consensus.full}; ready=${raw.coverageReady}; aggregate=${manifest.aggregateSha256})\n`);
