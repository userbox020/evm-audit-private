#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-endpoint-coverage-repair";
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const R4_INPUT_RAW = `reports/raw/fast/history/${NAME}-r4-input.json`;
const R4_INPUT_MANIFEST = `reports/raw/fast/history/${NAME}-r4-input-manifest.json`;
const REVISION = "etherfi-behype-endpoint-coverage-repair-r6-abi-corrected-offline-final";
const AGENT = "critical-etherfi-behype-config-abi-fix-20260722";
const R4_REVISION = "etherfi-behype-endpoint-coverage-repair-reviewer-r4-offline-final";
const R5_RUN = "etherfi-behype-endpoint-coverage-r5-ab59ace2e490089a-13192a34d53c";
const LZ_COMMIT = "9c741e7f9790639537b1710a203bcdfd73b0b9ac";
const CLASSIFICATION = "INFORMATIONAL/TOOLING-DEFECT-CORRECTED/ACCESS-COVERAGE_OPEN/HYPEREVM-SECOND-FAMILY-ABSENT";
const WARNING = "Failure-summary counts are aggregate per-field incidences, not unique providers/families and cannot be compared to chain-level Families.";
const DIGEST_SCHEMA = "etherfi-behype-observation-digest-v2-lz-uln302-abi-corrected";
const CONFIG_SCHEMA = "layerzero-v2-uln302-config-query-schema-v1";
const abs = (x) => path.join(ROOT, x);
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");

const rawText = fs.readFileSync(abs(RAW), "utf8"); const raw = JSON.parse(rawText);
const manifestText = fs.readFileSync(abs(MANIFEST), "utf8"); const manifest = JSON.parse(manifestText);
const report = fs.readFileSync(abs(REPORT), "utf8");
const inboxText = fs.readFileSync(abs(INBOX), "utf8"); const inbox = JSON.parse(inboxText);
const handoff = fs.readFileSync(abs(HANDOFF), "utf8");

assert.strictEqual(raw.schemaVersion, 2);
assert.strictEqual(raw.revision, REVISION);
assert.strictEqual(raw.agentId, AGENT);
assert(raw.runId.startsWith("etherfi-behype-endpoint-coverage-r6-"));
assert.strictEqual(raw.classification, CLASSIFICATION);
assert.strictEqual(raw.severity, "Informational");
assert.strictEqual(raw.protocolVulnerability, false);
assert.strictEqual(raw.defectType, "audit-tooling-false-coverage-negative");
assert.strictEqual(raw.routePositive, 0);
assert.strictEqual(raw.executableNow, 0);
assert.strictEqual(raw.signedActionJustified, false);
assert.strictEqual(raw.fork, false);
assert.strictEqual(raw.safety.offlineOnly, true);
assert.strictEqual(raw.safety.endpointInventoriesReadThisRun, false);
assert.strictEqual(raw.safety.networkCalls, false);
assert.strictEqual(raw.safety.economicsCalls, false);
for (const key of ["ethSendMethodsUsed", "signingUsed", "forkCreated", "stateMutation"]) assert.strictEqual(raw.safety[key], false, key);

assert.strictEqual(raw.officialLayerZeroReference.commit, LZ_COMMIT);
assert.strictEqual(raw.officialLayerZeroReference.networkReadThisRun, false);
assert.strictEqual(raw.abiModel.schemaId, CONFIG_SCHEMA);
assert.deepStrictEqual(raw.abiModel.librarySelection.send.returns, [{ name: "lib", type: "address" }]);
assert.deepStrictEqual(raw.abiModel.librarySelection.receive.returns, [{ name: "lib", type: "address" }, { name: "isDefault", type: "bool" }]);
assert.deepStrictEqual(Object.keys(raw.abiModel.librarySchema.send.configTypes).sort(), ["1", "2"]);
assert.deepStrictEqual(Object.keys(raw.abiModel.librarySchema.receive.configTypes), ["2"]);
assert.strictEqual(raw.abiModel.librarySchema.receive.unsupportedConfigTypes["1"].applicability, "not-applicable");
assert.strictEqual(raw.abiModel.librarySchema.receive.unsupportedConfigTypes["1"].deterministicRevert, "LZ_ULN_InvalidConfigType(uint32)");
assert.deepStrictEqual(raw.abiModel.configEnvelope.returns, [{ name: "config", type: "bytes" }]);
assert.deepStrictEqual(raw.abiModel.configEnvelope.abiEncoding, { head: "uint256-offset", tail: ["uint256-byte-length", "right-padded-byte-payload"] });
assert.strictEqual(raw.abiModel.configEnvelope.rawPayloadRetainedInInputs, false);
assert.strictEqual(raw.abiModel.configEnvelope.rawPayloadFabricated, false);
assert(Object.values(raw.abiModel.failClosed).every(Boolean));
assert.strictEqual(raw.digestSchema.schemaId, DIGEST_SCHEMA);
assert.strictEqual(raw.digestSchema.priorDigestIdsReused, false);
assert.strictEqual(raw.digestSchema.rawValuesAvailable, false);

assert.strictEqual(raw.provenance.derivedFromImmutableR4Inputs, true);
assert.strictEqual(raw.provenance.r4WasOfflineDiagnosticDerivationOfR3TestedSnapshot, true);
assert.strictEqual(raw.provenance.supersedesR5.runId, R5_RUN);
assert(raw.provenance.supersedesR5.reason.includes("receive-side ULN302 config type 1"));
assert.strictEqual(raw.provenance.r5ObservationSourceWasSameImmutableR4Snapshot, true);
assert.strictEqual(raw.provenance.originalR3MutableArtifactsAvailable, false);
assert.strictEqual(raw.provenance.independentlyReproducibleR3SourceAggregateClaimed, false);
assert.strictEqual(raw.provenance.r3ProvenanceStatus, "UNAVAILABLE/ORIGINAL-MUTABLE-R3-FILES-OVERWRITTEN");

const categoryEnum = new Set([
  "ok-value", "ok-empty/default", "rpc-error", "protocol-incompatible", "decode/config-selection-failure",
  "auth-or-origin-rejected", "rate-limited", "transport-error", "timeout", "http-4xx", "http-5xx",
  "library-selection-decode-failure", "unresolved/default/zero-library", "library-selection-rpc/transport-failure", "config-call-rpc/transport-failure",
  "not-applicable", "unsupported-or-ambiguous-library-schema",
]);
const success = (field) => field.outcome === "ok-value" || field.outcome === "ok-empty/default" && !field.requiredNonEmpty;

function pairConsensus(providers, tupleKey, completeKey) {
  const groups = new Map();
  for (const provider of providers.filter((row) => row.exactRetainedPin && row.retainedHashStable && row.finalizedHeightBound && row[completeKey] && row.anchorWindowHistoryNonEmpty && row.anchorWindowDigestId)) {
    const key = `${provider[tupleKey]}:${provider.anchorWindowDigestId}`; const families = groups.get(key) || new Set(); families.add(provider.providerFamilyId); groups.set(key, families);
  }
  return Math.max(0, ...[...groups.values()].map((families) => families.size));
}

function validateChain(name) {
  const row = raw[name]; const providers = row.providers;
  assert.strictEqual(row.initialProbeStatusCategoriesExcludedFromStateAndReadiness, true);
  assert.strictEqual(row.abiNormalization.schemaId, CONFIG_SCHEMA);
  assert.strictEqual(row.abiNormalization.receiveType1NotApplicableCount, providers.length);
  assert.strictEqual(row.abiNormalization.receiveType1ExcludedFromCompletenessAndDiagnostics, true);
  assert.deepStrictEqual(row.abiNormalization.sendRequiredConfigTypes, [1, 2]);
  assert.deepStrictEqual(row.abiNormalization.receiveRequiredConfigTypes, [2]);
  assert.strictEqual(row.abiNormalization.unsupportedOrAmbiguousFailClosed, true);
  assert(row.initialProbeStatusCategoryCounts && typeof row.initialProbeStatusCategoryCounts === "object");
  assert(!Object.prototype.hasOwnProperty.call(row, "statusCategoryCounts"));
  const expectedDiagnostics = new Map();
  for (const provider of providers) {
    assert.strictEqual(provider.probeAndTransportCategoriesExcludedFromReadiness, true);
    assert(Array.isArray(provider.probeAndTransportStatusCategories));
    assert.strictEqual(provider.digestSchemaId, DIGEST_SCHEMA);
    assert.strictEqual(provider.priorDigestIdsReused, false);
    for (const key of ["coreTupleDigestId", "configTupleDigestId", "fullTupleDigestId"]) {
      assert(provider[key].startsWith(`${DIGEST_SCHEMA}:`), `${name} new digest prefix ${key}`);
      assert(!Object.values(provider.sourceTupleDigestIds).includes(provider[key]), `${name} reused prior digest ${key}`);
    }
    const labels = provider.stateFieldOutcomes.map((field) => field.field); assert.strictEqual(new Set(labels).size, labels.length);
    const core = provider.stateFieldOutcomes.filter((field) => field.tier === "core");
    const config = provider.stateFieldOutcomes.filter((field) => field.tier === "config");
    const requiredConfig = config.filter((field) => field.requiredForConfigCompleteness);
    const receiveType1 = config.filter((field) => field.libraryDirection === "receive" && field.configType === 1);
    const receiveType2 = config.filter((field) => field.libraryDirection === "receive" && field.configType === 2);
    const sendType1 = config.filter((field) => field.libraryDirection === "send" && field.configType === 1);
    const sendType2 = config.filter((field) => field.libraryDirection === "send" && field.configType === 2);
    assert.strictEqual(receiveType1.length, 1);
    assert.strictEqual(receiveType2.length, 1);
    assert.strictEqual(sendType1.length, 1);
    assert.strictEqual(sendType2.length, 1);
    for (const field of receiveType1) {
      assert.strictEqual(field.outcome, "not-applicable");
      assert.strictEqual(field.applicability, "not-applicable");
      assert.strictEqual(field.requiredForConfigCompleteness, false);
      assert.strictEqual(field.excludedFromDiagnostics, true);
      assert.strictEqual(field.deterministicProtocolBehavior, "LZ_ULN_InvalidConfigType(uint32)");
      assert.strictEqual(field.sourceObservation.outcome === "config-call-rpc/transport-failure" || field.sourceObservation.outcome === "library-selection-rpc/transport-failure", true);
      assert.strictEqual(field.valueDigestId, null);
      assert.strictEqual(field.rawValueFabricated, false);
    }
    for (const field of [...receiveType2, ...sendType1, ...sendType2]) {
      assert.strictEqual(field.applicability, "required");
      assert.strictEqual(field.requiredForConfigCompleteness, true);
      assert.strictEqual(field.configReturnEnvelope.returns[0].type, "bytes");
      assert(field.decodedConfigSchema && Array.isArray(field.decodedConfigSchema.tuple));
      assert.strictEqual(field.sourceObservation.rawValueRetained, false);
      assert.strictEqual(field.rawValueFabricated, false);
    }
    for (const field of config.filter((item) => item.field.endsWith(".librarySelection"))) {
      assert.strictEqual(field.requiredForConfigCompleteness, true);
      assert.strictEqual(field.librarySelectionReturn[0].type, "address");
      if (field.libraryDirection === "receive") assert.deepStrictEqual(field.librarySelectionReturn.map((item) => item.type), ["address", "bool"]);
      if (field.libraryDirection === "send") assert.deepStrictEqual(field.librarySelectionReturn.map((item) => item.type), ["address"]);
    }
    for (const field of provider.stateFieldOutcomes) {
      assert(categoryEnum.has(field.outcome), `${name} category enum ${field.field}`);
      if (field.applicability !== "not-applicable" && !success(field)) { const list = expectedDiagnostics.get(field.field) || []; list.push({ family: provider.providerFamilyId, outcome: field.outcome }); expectedDiagnostics.set(field.field, list); }
    }
    assert.strictEqual(provider.minimalCoreComplete, core.every(success));
    assert.strictEqual(provider.configExtensionComplete, requiredConfig.length > 0 && requiredConfig.every(success));
    assert.strictEqual(provider.fullTupleComplete, provider.minimalCoreComplete && provider.configExtensionComplete);
  }
  assert(!row.fieldDiagnostics.some((item) => item.field.endsWith(".receive.type1")), `${name} receive type1 diagnostic retained`);
  const diagnostics = new Map(row.fieldDiagnostics.map((item) => [item.field, item]));
  assert.deepStrictEqual([...diagnostics.keys()].sort(), [...expectedDiagnostics.keys()].sort());
  for (const [field, failures] of expectedDiagnostics) {
    const actual = diagnostics.get(field); const categories = [...new Set(failures.map((item) => item.outcome))].sort();
    assert.deepStrictEqual(Object.keys(actual.categories).sort(), categories);
    assert.strictEqual(actual.affectedProviderCount, failures.length);
    assert.strictEqual(actual.affectedProviderFamilyGroupCount, new Set(failures.map((item) => item.family)).size);
  }
  const coreConsensus = pairConsensus(providers, "coreTupleDigestId", "minimalCoreComplete");
  const configConsensus = pairConsensus(providers, "configTupleDigestId", "configExtensionComplete");
  const fullConsensus = pairConsensus(providers, "fullTupleDigestId", "fullTupleComplete");
  assert.strictEqual(row.metrics.minimalCoreConsensusProviderFamilyGroups, coreConsensus);
  assert.strictEqual(row.metrics.configExtensionConsensusProviderFamilyGroups, configConsensus);
  assert.strictEqual(row.metrics.fullTupleConsensusProviderFamilyGroups, fullConsensus);
  assert.strictEqual(row.readiness.minimalCoreProviderFamilyConsensusReady, coreConsensus >= 2);
  assert.strictEqual(row.readiness.configExtensionProviderFamilyConsensusReady, configConsensus >= 2);
  assert.strictEqual(row.readiness.fullTupleProviderFamilyConsensusReady, fullConsensus >= 2);
  assert.strictEqual(row.endpointValuesPersisted, false);
  assert.strictEqual(row.providerFamilyNamesPersisted, false);
  assert.strictEqual(row.backendOrOperatorIndependenceClaimed, false);
  return { coreConsensus, configConsensus, fullConsensus };
}
const opConsensus = validateChain("optimism");
const hyperConsensus = validateChain("hyperevm");

assert.deepStrictEqual({ core: raw.optimism.metrics.minimalCoreComplete, config: raw.optimism.metrics.configExtensionComplete, full: raw.optimism.metrics.fullTupleComplete }, { core: 2, config: 3, full: 2 });
assert.deepStrictEqual(opConsensus, { coreConsensus: 2, configConsensus: 3, fullConsensus: 2 });
assert.strictEqual(raw.optimism.readiness.minimalCoreProviderFamilyConsensusReady, true);
assert.strictEqual(raw.optimism.readiness.configExtensionProviderFamilyConsensusReady, true);
assert.strictEqual(raw.optimism.readiness.fullTupleProviderFamilyConsensusReady, true);
assert.deepStrictEqual({ core: raw.hyperevm.metrics.minimalCoreComplete, config: raw.hyperevm.metrics.configExtensionComplete, full: raw.hyperevm.metrics.fullTupleComplete }, { core: 1, config: 1, full: 1 });
assert.deepStrictEqual(hyperConsensus, { coreConsensus: 1, configConsensus: 1, fullConsensus: 1 });
assert.strictEqual(raw.hyperevm.metrics.observedProviderFamilyGroups, 1);
assert.strictEqual(raw.hyperevm.readiness.minimalCoreProviderFamilyConsensusReady, false);
assert.strictEqual(raw.hyperevm.readiness.configExtensionProviderFamilyConsensusReady, false);
assert.strictEqual(raw.hyperevm.readiness.fullTupleProviderFamilyConsensusReady, false);
assert.strictEqual(raw.providerFamilyConsensusReadiness.bothFullTuple, false);
assert(raw.disposition.optimism.includes("THREE-FAMILY-CONFIG-CONSENSUS"));
assert(raw.disposition.optimism.includes("TWO-FAMILY-FULL-TUPLE"));
assert(raw.disposition.hyperevm.includes("ONE-FAMILY-CONFIG-AND-FULL-OBSERVATION"));
assert.strictEqual(raw.disposition.overall, CLASSIFICATION);
assert.strictEqual(raw.failureSummaryCountSemanticsWarning, WARNING);
assert(raw.nextReadOnlyStep.includes("second HyperEVM provider family"));
assert(raw.nextReadOnlyStep.includes("r6 ABI schema"));
assert(raw.nextReadOnlyStep.includes("economics remains blocked"));

const r4RawBytes = fs.readFileSync(abs(R4_INPUT_RAW)); const r4ManifestBytes = fs.readFileSync(abs(R4_INPUT_MANIFEST));
const r4Input = JSON.parse(r4RawBytes.toString("utf8")); const r4InputManifest = JSON.parse(r4ManifestBytes.toString("utf8"));
assert.strictEqual(r4Input.revision, R4_REVISION);
assert.strictEqual(r4InputManifest.revision, R4_REVISION);
assert.strictEqual(r4Input.runId, r4InputManifest.runId);
assert.strictEqual(raw.immutableInputs.r4Raw.path, R4_INPUT_RAW);
assert.strictEqual(raw.immutableInputs.r4Raw.bytes, r4RawBytes.length);
assert.strictEqual(raw.immutableInputs.r4Raw.sha256, hash(r4RawBytes));
assert.strictEqual(raw.immutableInputs.r4Manifest.path, R4_INPUT_MANIFEST);
assert.strictEqual(raw.immutableInputs.r4Manifest.bytes, r4ManifestBytes.length);
assert.strictEqual(raw.immutableInputs.r4Manifest.sha256, hash(r4ManifestBytes));
assert.strictEqual(raw.immutableInputs.copiedByteForByteBeforeMutableOverwrite, true);
const r4MutableRawRecord = r4InputManifest.records.find((row) => row.path === RAW);
assert(r4MutableRawRecord);
assert.strictEqual(r4MutableRawRecord.bytes, r4RawBytes.length);
assert.strictEqual(r4MutableRawRecord.sha256, hash(r4RawBytes));
assert.strictEqual(raw.provenance.sourceR4RunId, r4Input.runId);
assert.strictEqual(raw.provenance.sourceR4Revision, r4Input.revision);
assert.strictEqual(raw.provenance.sourceR4ManifestAggregateSha256, r4InputManifest.aggregateSha256);

assert.strictEqual(manifest.schemaVersion, 2);
assert.strictEqual(manifest.revision, REVISION);
assert.strictEqual(manifest.runId, raw.runId);
assert.strictEqual(manifest.classification, raw.classification);
assert.strictEqual(manifest.severity, "Informational");
assert.strictEqual(manifest.protocolVulnerability, false);
assert.strictEqual(manifest.offlineOnly, true);
assert.strictEqual(manifest.endpointInventoriesReadThisRun, false);
assert.deepStrictEqual(manifest.providerFamilyConsensusReadiness, raw.providerFamilyConsensusReadiness);
assert.deepStrictEqual(manifest.disposition, raw.disposition);
assert.deepStrictEqual(manifest.correctedMetrics.optimism, raw.optimism.metrics);
assert.deepStrictEqual(manifest.correctedMetrics.hyperevm, raw.hyperevm.metrics);
assert.strictEqual(manifest.routePositive, 0);
assert.strictEqual(manifest.executableNow, 0);
assert.strictEqual(manifest.signedActionJustified, false);
assert.strictEqual(manifest.fork, false);
assert.strictEqual(manifest.endpointValuesPersisted, false);
assert.strictEqual(manifest.backendOrOperatorIndependenceClaimed, false);
assert.deepStrictEqual(manifest.immutableInputs, raw.immutableInputs);
assert.deepStrictEqual(manifest.provenance, raw.provenance);
assert.strictEqual(manifest.failureSummaryCountSemanticsWarning, WARNING);
assert(manifest.records.some((row) => row.path === R4_INPUT_RAW));
assert(manifest.records.some((row) => row.path === R4_INPUT_MANIFEST));
for (const source of raw.officialLayerZeroReference.sourceRecords) assert(manifest.records.some((row) => row.path === source.path));
assert.strictEqual(inbox.runId, raw.runId);
assert.strictEqual(inbox.agentId, AGENT);
assert.strictEqual(inbox.revision, REVISION);
assert.strictEqual(inbox.severity, "Informational");
assert.strictEqual(inbox.protocolVulnerability, false);
assert(handoff.includes(raw.runId));
assert(report.includes(raw.runId));
assert(report.includes("INFORMATIONAL TOOLING DEFECT CORRECTED"));
assert(report.includes("not a protocol vulnerability"));
assert(report.includes("Receive type 1 is explicitly not applicable"));
assert(report.includes("dynamic `bytes` ABI envelope"));
assert(report.includes("Unsupported or ambiguous library kind/version/config type is fail-closed"));
assert(report.includes("No independently reproducible r3 aggregate is claimed"));
assert(report.includes("nextReadOnlyStep"));

for (const record of manifest.records) {
  const data = fs.readFileSync(abs(record.path));
  assert.strictEqual(data.length, record.bytes, `bytes ${record.path}`);
  assert.strictEqual(hash(data), record.sha256, `hash ${record.path}`);
}
assert.strictEqual(hash(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")), manifest.aggregateSha256);

// Strict offline leak gate over all emitted artifacts. Source references are
// local paths and commit/hash metadata only; no endpoint inventory is read.
const publishedFiles = [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF];
const published = publishedFiles.map((file) => fs.readFileSync(abs(file), "utf8")).join("\n");
assert(!/(?:https?|wss?):\/\//i.test(published), "scheme leak");
assert(!/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(published), "host-like leak");
assert(!/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(published), "header or credential leak");
assert(!/"(?:url|domain|providerName|rawLine|headers?)"\s*:/i.test(published), "raw endpoint field leak");
assert.strictEqual(raw.safety.endpointValuesPersisted, false);
assert.strictEqual(raw.safety.rawInventoryLinesPersisted, false);
assert.strictEqual(raw.provenance.originalR3MutableArtifactsAvailable, false);
assert.strictEqual(raw.provenance.independentlyReproducibleR3SourceAggregateClaimed, false);

process.stdout.write(`PASS EtherFi BeHYPE endpoint config ABI correction r6 offline (${raw.runId}; op-complete=${raw.optimism.metrics.minimalCoreComplete}/${raw.optimism.metrics.configExtensionComplete}/${raw.optimism.metrics.fullTupleComplete}; op-consensus=${opConsensus.coreConsensus}/${opConsensus.configConsensus}/${opConsensus.fullConsensus}; hyper-complete=${raw.hyperevm.metrics.minimalCoreComplete}/${raw.hyperevm.metrics.configExtensionComplete}/${raw.hyperevm.metrics.fullTupleComplete}; hyper-consensus=${hyperConsensus.coreConsensus}/${hyperConsensus.configConsensus}/${hyperConsensus.fullConsensus}; aggregate=${manifest.aggregateSha256})\n`);
