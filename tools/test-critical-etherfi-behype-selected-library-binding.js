#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-selected-library-binding";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const R6_RAW = "reports/raw/fast/critical-etherfi-behype-endpoint-coverage-repair.json";
const R6_MANIFEST = "reports/raw/fast/critical-etherfi-behype-endpoint-coverage-repair-manifest.json";
const REVISION = "etherfi-behype-selected-library-binding-r7-fixed-pin-sanitized";
const AGENT = "critical-etherfi-behype-library-binding-r7-20260722";
const LZ_COMMIT = "9c741e7f9790639537b1710a203bcdfd73b0b9ac";
const FAMILY_STATUS = "ULN302-COMPATIBLE-SEMANTICS-BOUND/EXACT-OFFICIAL-RUNTIME-EQUIVALENCE-UNPROVEN";
const abs = (rel) => path.join(ROOT, rel);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { bytes: body.length, sha256: sha(body) }; };

const raw = JSON.parse(read(RAW));
const manifest = JSON.parse(read(MANIFEST));
const report = read(REPORT);
const inbox = JSON.parse(read(INBOX));
const handoff = read(HANDOFF);

assert.strictEqual(raw.schemaVersion, 1);
assert.strictEqual(raw.revision, REVISION);
assert.strictEqual(raw.agentId, AGENT);
assert(raw.runId.startsWith("etherfi-behype-selected-library-r7-"));
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
assert.strictEqual(raw.safety.readOnly, true);
assert.strictEqual(raw.safety.networkCalls, true);
assert.strictEqual(raw.safety.networkScope, "authorized endpoint inventories only");
assert.strictEqual(raw.safety.endpointInventoriesReadThisRun, true);
assert.strictEqual(raw.safety.endpointValuesEmitted, false);
assert.strictEqual(raw.safety.secretsPersisted, false);
for (const key of ["economicsCalls", "stakeCalls", "messageSendCalls", "signing", "transactions", "forkCreated", "mutation"]) assert.strictEqual(raw.safety[key], false, key);

assert.strictEqual(raw.inventory.rpcInventoryRead, true);
assert.strictEqual(raw.inventory.graphqlInventoryRead, true);
assert.strictEqual(raw.inventory.graphqlCalls, 0);
assert(raw.inventory.rpcCandidatesParsed > 0);
assert.strictEqual(raw.inventory.endpointValuesPersisted, false);
assert.strictEqual(raw.inventory.providerDomainsPersisted, false);
assert.strictEqual(raw.inventory.providerNamesPersisted, false);
assert.strictEqual(raw.inventory.rawInventoryLinesPersisted, false);
assert.strictEqual(raw.inventory.inventoryHashesPersisted, false);
assert.strictEqual(raw.officialLayerZero.commit, LZ_COMMIT);
assert.strictEqual(raw.officialLayerZero.exactSelectedLibraryRuntimeEquivalence, null);
assert.strictEqual(raw.officialLayerZero.semanticBindingRequiresObservedTypeVersionCodeConfig, true);
assert.strictEqual(raw.rejectedPredecessorR6.status, "REJECTED/SUPERSEDED-FOR-SELECTED-LIBRARY-FAMILY-INFERENCE");
assert(raw.rejectedPredecessorR6.reason.includes("messageLibType"));
assert.strictEqual(raw.rejectedPredecessorR6.raw.path, R6_RAW);
assert.strictEqual(raw.rejectedPredecessorR6.manifest.path, R6_MANIFEST);

const expectedRoutes = {
  optimism: {
    "optimism-whype-send-30367": { app: "0xd83e3d560ba6f05094d9d8b3eb8aaea571d1864e", eid: 30367, direction: "send", configs: [1, 2], type: new Set(["Send", "SendAndReceive"]) },
    "optimism-behype-receive-30367": { app: "0xa519afbc91986c0e7501d7e34968fee51cd901ac", eid: 30367, direction: "receive", configs: [2], type: new Set(["Receive", "SendAndReceive"]) },
  },
  hyperevm: {
    "hyperevm-whype-receive-30111": { app: "0x2b7e48511ea616101834f09945c11f7d78d9136d", eid: 30111, direction: "receive", configs: [2], type: new Set(["Receive", "SendAndReceive"]) },
    "hyperevm-behype-send-30111": { app: "0x637de4a55cdd37700f9b54451b709b01040d48df", eid: 30111, direction: "send", configs: [1, 2], type: new Set(["Send", "SendAndReceive"]) },
  },
};

function recomputeConsensus(families, keys) {
  const groups = new Map();
  for (const family of families.filter((row) => row.complete)) {
    const key = keys.map((name) => family[name]).join(":"); const set = groups.get(key) || new Set(); set.add(family.familyId); groups.set(key, set);
  }
  return Math.max(0, ...[...groups.values()].map((set) => set.size));
}

for (const [chainName, chain] of Object.entries(raw.chains)) {
  assert(["optimism", "hyperevm"].includes(chainName));
  assert.strictEqual(chain.routeDefinitions.length, 2);
  for (const definition of chain.routeDefinitions) {
    const expected = expectedRoutes[chainName][definition.id]; assert(expected, definition.id);
    assert.strictEqual(definition["app"], expected["app"]);
    assert.strictEqual(definition.remoteEid, expected.eid);
    assert.strictEqual(definition.direction, expected.direction);
    assert.deepStrictEqual(definition.applicableConfigTypes, expected.configs);
  }
  if (!chain.pin) {
    assert.strictEqual(chain.status, "NO-FINALIZED-PROVIDER");
    assert.strictEqual(chain.providers.length, 0);
    assert.strictEqual(chain.families.length, 0);
    assert.strictEqual(chain.coverageReady, false);
    assert.deepStrictEqual(chain.consensus, { codeVersion: 0, config: 0, fullWithAnchor: 0, retainedState: 0, selection: 0 });
    continue;
  }
  assert(chain.pin && Number.isSafeInteger(chain.pin.blockNumber));
  assert(/^0x[0-9a-f]{64}$/.test(chain.pin.blockHash));
  assert.strictEqual(chain.pin.retainedHashRechecked, chain.providers.some((row) => row.complete) && chain.providers.filter((row) => row.complete).every((row) => row.retainedHashStable));
  assert.strictEqual(chain.pin.finalizedHeightBound, chain.providers.some((row) => row.complete) && chain.providers.filter((row) => row.complete).every((row) => row.finalizedHeightBound));
  assert.strictEqual(chain.metrics.exactPinProviders, chain.providers.length);
  assert.strictEqual(chain.metrics.exactPinFamilies, chain.families.length);
  assert.strictEqual(chain.metrics.completeProviders, chain.providers.filter((row) => row.complete).length);
  assert.strictEqual(chain.metrics.completeFamilies, chain.families.filter((row) => row.complete).length);
  const familyIds = new Set(chain.families.map((row) => row.familyId));
  assert.strictEqual(familyIds.size, chain.families.length);
  for (const family of chain.families) {
    assert(new RegExp(`^${chainName}-family-\\d{2}$`).test(family.familyId));
    assert.strictEqual(family.providerCount, chain.providers.filter((row) => row.familyId === family.familyId).length);
    if (family.complete) assert(Object.values(family.equality).every(Boolean));
  }
  for (const provider of chain.providers) {
    assert(new RegExp(`^${chainName}-provider-\\d{2}$`).test(provider.providerId));
    assert(familyIds.has(provider.familyId));
    assert.strictEqual(provider.exactPin, true);
    if (!provider.complete) continue;
    assert.strictEqual(provider.retainedHashStable, true);
    assert.strictEqual(provider.finalizedHeightBound, true);
    assert(/^([0-9a-f]{64})$/.test(provider.selectionTupleDigest));
    assert(/^([0-9a-f]{64})$/.test(provider.codeVersionTupleDigest));
    assert(/^([0-9a-f]{64})$/.test(provider.configTupleDigest));
    assert(/^([0-9a-f]{64})$/.test(provider.retainedStateTupleDigest));
    assert.strictEqual(provider.anchorWindow.toBlock, chain.pin.blockNumber);
    assert.strictEqual(provider.anchorWindow.toBlock - provider.anchorWindow.fromBlock + 1, 64);
    assert.strictEqual(provider.anchorWindow.rawLogsPersisted, false);
    assert.strictEqual(provider.routes.length, 2);
    for (const route of provider.routes) {
      const expected = expectedRoutes[chainName][route.routeId]; assert(expected, route.routeId);
      assert.strictEqual(route.binding["app"], expected["app"]);
      assert.strictEqual(route.binding.remoteEid, expected.eid);
      assert.strictEqual(route.binding.direction, expected.direction);
      assert.strictEqual(route.binding.appEndpointMatches, true);
      assert.strictEqual(route.binding.peerNonzero, true);
      assert(/^0x[0-9a-f]{40}$/.test(route.selection.selectedLibrary));
      assert.deepStrictEqual(route.selection.returnShape, ["address", "bool"]);
      assert.strictEqual(route.selection.strictDecoded, true);
      assert.strictEqual(route.selection.rawResultPersisted, false);
      assert.strictEqual(route.runtime.selectedAddress, route.selection.selectedLibrary);
      assert(/^0x[0-9a-f]{64}$/.test(route.runtime.selectedCodeHash));
      assert(/^0x[0-9a-f]{64}$/.test(route.runtime.effectiveCodeHash));
      assert.strictEqual(route.runtime.proxy.proxyAmbiguous, false);
      assert(Object.values(route.runtime.selectorEvidence.present).every(Boolean));
      assert(expected.type.has(route.semantics.messageLibType));
      assert.deepStrictEqual(route.semantics.version, { endpointVersion: 2, major: "3", minor: 0 });
      assert.strictEqual(route.semantics.supportedEid, true);
      assert.strictEqual(route.semantics.registeredAtEndpoint, true);
      assert.strictEqual(route.semantics.directionTypeMatches, true);
      assert.strictEqual(route.semantics.versionMatchesUln302, true);
      assert.strictEqual(route.semantics.semanticEvidenceComplete, true);
      assert.strictEqual(route.semantics.familyBindingStatus, FAMILY_STATUS);
      assert.strictEqual(route.semantics.exactOfficialSourceRuntimeEquivalence, null);
      assert.deepStrictEqual(route.semantics.applicableConfigTypes, expected.configs);
      assert.deepStrictEqual(route.semantics.nonApplicableConfigTypesCalled, []);
      assert.deepStrictEqual(route.configs.map((row) => row.configType), expected.configs);
      for (const config of route.configs) {
        assert.strictEqual(config.strictEnvelopeDecode, true);
        assert.strictEqual(config.strictPayloadDecode, true);
        assert.strictEqual(config.rawEnvelopePersisted, false);
        assert.strictEqual(config.rawPayloadPersisted, false);
        assert(config.rawEnvelopeBytes > config.payloadBytes);
        assert(/^0x[0-9a-f]{64}$/.test(config.rawEnvelopeDigest));
        assert(/^0x[0-9a-f]{64}$/.test(config.payloadDigest));
        assert(/^[0-9a-f]{64}$/.test(config.decodedEffectiveSchemaDigest));
        if (config.configType === 1) assert.strictEqual(config.decodedSchema, "ExecutorConfig(uint32,address)");
        if (config.configType === 2) assert.strictEqual(config.decodedSchema, "UlnConfig(uint64,uint8,uint8,uint8,address[],address[])");
      }
      assert.strictEqual(route.complete, true);
    }
  }
  assert.strictEqual(chain.consensus.selection, recomputeConsensus(chain.families, ["selectionTupleDigest", "anchorWindowDigest"]));
  assert.strictEqual(chain.consensus.codeVersion, recomputeConsensus(chain.families, ["codeVersionTupleDigest", "anchorWindowDigest"]));
  assert.strictEqual(chain.consensus.config, recomputeConsensus(chain.families, ["configTupleDigest", "anchorWindowDigest"]));
  assert.strictEqual(chain.consensus.retainedState, recomputeConsensus(chain.families, ["retainedStateTupleDigest", "anchorWindowDigest"]));
  assert.strictEqual(chain.consensus.fullWithAnchor, recomputeConsensus(chain.families, ["selectionTupleDigest", "codeVersionTupleDigest", "configTupleDigest", "retainedStateTupleDigest", "anchorWindowDigest"]));
  assert.strictEqual(chain.coverageReady, chain.consensus.fullWithAnchor >= 2);
}

assert.strictEqual(raw.gates.optimismSelectedLibraryConsensus, raw.chains.optimism.coverageReady);
assert.strictEqual(raw.gates.hyperevmSelectedLibraryConsensus, raw.chains.hyperevm.coverageReady);
assert.strictEqual(raw.gates.bothChainsSelectedLibraryConsensus, raw.chains.optimism.coverageReady && raw.chains.hyperevm.coverageReady);
assert.strictEqual(raw.gates.economicsBlocked, true);
if (!raw.chains.hyperevm.coverageReady) assert(raw.classification.startsWith("WATCH/COVERAGE_OPEN/"));
assert(raw.nextReadOnlyStep.includes("HyperEVM") || raw.chains.hyperevm.coverageReady);

assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(manifest.classification, raw.classification);
assert.deepStrictEqual(manifest.pins, raw.pins);
assert.deepStrictEqual(manifest.gates, raw.gates);
assert.strictEqual(manifest.routePositive, 0);
assert.strictEqual(manifest.executableNow, 0);
assert.strictEqual(manifest.signedActionJustified, false);
assert.strictEqual(manifest.fork, false);
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(inbox.agentId, AGENT);
assert.strictEqual(inbox.libraryBindingStatus, FAMILY_STATUS);
assert(report.includes(raw.runId));
assert(report.includes("🟠 WATCH"));
assert(report.includes("R6 is preserved as rejected predecessor evidence"));
assert(report.includes("No receive-side config type 1 call was made"));
assert(handoff.includes(raw.runId));

for (const record of manifest.records) {
  const current = hashFile(record.path);
  assert.strictEqual(current.bytes, record.bytes, `bytes ${record.path}`);
  assert.strictEqual(current.sha256, record.sha256, `hash ${record.path}`);
}
assert.strictEqual(sha(Buffer.from(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))), manifest.aggregateSha256);

const published = [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF].map(read).join("\n");
assert(!/(?:https?|wss?):\/\//i.test(published), "scheme leak");
assert(!/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(published), "host leak");
assert(!/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(published), "credential leak");
assert(!/"(?:url|domain|providerName|rawLine|headers?)"\s*:/i.test(published), "endpoint field leak");

process.stdout.write(`PASS EtherFi BeHYPE selected-library binding r7 (${raw.runId}; op-pin=${raw.chains.optimism.pin?.blockNumber ?? "unavailable"}; hyper-pin=${raw.chains.hyperevm.pin?.blockNumber ?? "unavailable"}; op-families=${raw.chains.optimism.metrics.exactPinFamilies || 0}/${raw.chains.optimism.metrics.completeFamilies || 0}; hyper-families=${raw.chains.hyperevm.metrics.exactPinFamilies || 0}/${raw.chains.hyperevm.metrics.completeFamilies || 0}; op-consensus=${raw.chains.optimism.consensus.fullWithAnchor}; hyper-consensus=${raw.chains.hyperevm.consensus.fullWithAnchor}; aggregate=${manifest.aggregateSha256})\n`);
