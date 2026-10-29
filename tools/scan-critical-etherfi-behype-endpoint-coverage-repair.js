#!/usr/bin/env node
"use strict";

// Offline-only r6 ABI-correction packager. It reads only immutable sanitized
// r4 observations and their immutable manifest. It performs no endpoint
// inventory reads, network access, economics calls, or state mutation.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-endpoint-coverage-repair";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const R4_INPUT_RAW = `reports/raw/fast/history/${NAME}-r4-input.json`;
const R4_INPUT_MANIFEST = `reports/raw/fast/history/${NAME}-r4-input-manifest.json`;
const LZ_SOURCES = [
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/MessageLibManager.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/EndpointV2.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/interfaces/IMessageLibManager.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/protocol/contracts/interfaces/IMessageLib.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/uln302/SendUln302.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/uln302/ReceiveUln302.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/SendLibBase.sol",
  "targets/layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/UlnBase.sol",
];
const REVISION = "etherfi-behype-endpoint-coverage-repair-r6-abi-corrected-offline-final";
const AGENT = "critical-etherfi-behype-config-abi-fix-20260722";
const R4_REVISION = "etherfi-behype-endpoint-coverage-repair-reviewer-r4-offline-final";
const R5_REVISION = "etherfi-behype-endpoint-coverage-repair-reviewer-r5-offline-final";
const R5_RUN = "etherfi-behype-endpoint-coverage-r5-ab59ace2e490089a-13192a34d53c";
const R5_MANIFEST_AGGREGATE = "379f8022d2f8b0fab47439f8b55535cf80662fdd10ccbc471794eade797c2551";
const LZ_COMMIT = "9c741e7f9790639537b1710a203bcdfd73b0b9ac";
const CLASSIFICATION = "INFORMATIONAL/TOOLING-DEFECT-CORRECTED/ACCESS-COVERAGE_OPEN/HYPEREVM-SECOND-FAMILY-ABSENT";
const WARNING = "Failure-summary counts are aggregate per-field incidences, not unique providers/families and cannot be compared to chain-level Families.";
const DIGEST_SCHEMA = "etherfi-behype-observation-digest-v2-lz-uln302-abi-corrected";
const CONFIG_SCHEMA = "layerzero-v2-uln302-config-query-schema-v1";

const abs = (x) => path.join(ROOT, x);
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const hashFile = (rel) => { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; };
const digestId = (kind, value) => `${DIGEST_SCHEMA}:${kind}:sha256:${sha(canonical(value))}`;
function writeOwned(rel, text) { if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error("write-refused"); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, "utf8"); }

const ABI_MODEL = Object.freeze({
  schemaId: CONFIG_SCHEMA,
  officialReference: {
    repository: "LayerZero-v2",
    commit: LZ_COMMIT,
    canonicalContracts: ["MessageLibManager", "EndpointV2", "SendUln302", "ReceiveUln302"],
  },
  librarySelection: {
    send: {
      function: "getSendLibrary(address,uint32)",
      returns: [{ name: "lib", type: "address" }],
      defaultStatus: { function: "isDefaultSendLibrary(address,uint32)", returns: [{ name: "isDefault", type: "bool" }] },
    },
    receive: {
      function: "getReceiveLibrary(address,uint32)",
      returns: [{ name: "lib", type: "address" }, { name: "isDefault", type: "bool" }],
      defaultStatus: { embeddedInReturnTuple: true },
    },
  },
  configEnvelope: {
    function: "getConfig(address,address,uint32,uint32)",
    returns: [{ name: "config", type: "bytes" }],
    abiEncoding: { head: "uint256-offset", tail: ["uint256-byte-length", "right-padded-byte-payload"] },
    rawPayloadRetainedInInputs: false,
    rawPayloadFabricated: false,
  },
  librarySchema: {
    family: "ULN302",
    version: { major: 3, minor: 0, endpointVersion: 2 },
    versionSource: "official-source-schema-qualification-not-retained-live-version-output",
    send: {
      kind: "Send",
      configTypes: {
        "1": { name: "ExecutorConfig", tuple: ["uint32 maxMessageSize", "address executor"] },
        "2": { name: "UlnConfig", tuple: ["uint64 confirmations", "uint8 requiredDVNCount", "uint8 optionalDVNCount", "uint8 optionalDVNThreshold", "address[] requiredDVNs", "address[] optionalDVNs"] },
      },
    },
    receive: {
      kind: "Receive",
      configTypes: {
        "2": { name: "UlnConfig", tuple: ["uint64 confirmations", "uint8 requiredDVNCount", "uint8 optionalDVNCount", "uint8 optionalDVNThreshold", "address[] requiredDVNs", "address[] optionalDVNs"] },
      },
      unsupportedConfigTypes: { "1": { applicability: "not-applicable", deterministicRevert: "LZ_ULN_InvalidConfigType(uint32)" } },
    },
  },
  failClosed: {
    unsupportedLibraryKind: true,
    ambiguousLibraryKind: true,
    unsupportedLibraryVersion: true,
    ambiguousLibraryVersion: true,
    unknownConfigType: true,
  },
});

const success = (field) => field.outcome === "ok-value" || field.outcome === "ok-empty/default" && !field.requiredNonEmpty;
const eligible = (provider, completeKey) => provider.exactRetainedPin && provider.retainedHashStable && provider.finalizedHeightBound && provider[completeKey];

function normalizeConfigField(field) {
  const sourceObservation = { outcome: field.outcome, valueDigestId: field.valueDigestId, rawValueRetained: false };
  const match = /^config\.(behype|whype)\.(send|receive)\.(librarySelection|type(\d+))$/.exec(field.field);
  if (!match) {
    return { ...field, sourceObservation, outcome: "unsupported-or-ambiguous-library-schema", valueDigestId: null, applicability: "required-fail-closed", requiredForConfigCompleteness: true, schemaStatus: "unsupported-or-ambiguous", abiSchemaId: CONFIG_SCHEMA, rawValueFabricated: false };
  }
  const [, asset, direction, leaf, typeText] = match;
  const librarySelection = ABI_MODEL.librarySelection[direction];
  const librarySchema = ABI_MODEL.librarySchema[direction];
  if (!librarySelection || !librarySchema) {
    return { ...field, sourceObservation, outcome: "unsupported-or-ambiguous-library-schema", valueDigestId: null, asset, libraryDirection: direction, applicability: "required-fail-closed", requiredForConfigCompleteness: true, schemaStatus: "unsupported-or-ambiguous", abiSchemaId: CONFIG_SCHEMA, rawValueFabricated: false };
  }
  const common = {
    ...field,
    sourceObservation,
    asset,
    libraryDirection: direction,
    libraryKind: librarySchema.kind,
    libraryFamily: ABI_MODEL.librarySchema.family,
    libraryVersionSchema: ABI_MODEL.librarySchema.version,
    libraryVersionObservedInRetainedInput: false,
    libraryVersionSchemaQualifiedByOfficialSource: true,
    abiSchemaId: CONFIG_SCHEMA,
    schemaStatus: "supported",
    rawValueFabricated: false,
  };
  if (leaf === "librarySelection") {
    return { ...common, applicability: "required", requiredForConfigCompleteness: true, librarySelectionReturn: librarySelection.returns, defaultStatusReturn: librarySelection.defaultStatus };
  }
  const configType = Number(typeText);
  const schema = librarySchema.configTypes[String(configType)];
  const unsupported = librarySchema.unsupportedConfigTypes?.[String(configType)];
  if (unsupported?.applicability === "not-applicable") {
    return {
      ...common,
      outcome: "not-applicable",
      valueDigestId: null,
      configType,
      applicability: "not-applicable",
      requiredForConfigCompleteness: false,
      excludedFromDiagnostics: true,
      deterministicProtocolBehavior: unsupported.deterministicRevert,
      configReturnEnvelope: ABI_MODEL.configEnvelope,
      decodedConfigSchema: null,
    };
  }
  if (!schema) {
    return { ...common, outcome: "unsupported-or-ambiguous-library-schema", valueDigestId: null, configType, applicability: "required-fail-closed", requiredForConfigCompleteness: true, schemaStatus: "unsupported-or-ambiguous", configReturnEnvelope: ABI_MODEL.configEnvelope, decodedConfigSchema: null };
  }
  return { ...common, configType, applicability: "required", requiredForConfigCompleteness: true, configReturnEnvelope: ABI_MODEL.configEnvelope, decodedConfigSchema: schema };
}

function fieldDigestRow(field) {
  return {
    field: field.field,
    tier: field.tier,
    requiredNonEmpty: field.requiredNonEmpty,
    outcome: field.outcome,
    valueDigestId: field.valueDigestId,
    applicability: field.applicability || "required",
    abiSchemaId: field.abiSchemaId || null,
    configType: field.configType ?? null,
    decodedConfigSchema: field.decodedConfigSchema || null,
  };
}

function normalizeProvider(provider) {
  const sourceTupleDigestIds = { core: provider.coreTupleDigestId, config: provider.configTupleDigestId, full: provider.fullTupleDigestId };
  const stateFieldOutcomes = provider.stateFieldOutcomes.map((field) => field.tier === "config" ? normalizeConfigField(field) : { ...field, applicability: "required" });
  const core = stateFieldOutcomes.filter((field) => field.tier === "core");
  const configRequired = stateFieldOutcomes.filter((field) => field.tier === "config" && field.requiredForConfigCompleteness);
  const minimalCoreComplete = core.every(success);
  const configExtensionComplete = configRequired.length > 0 && configRequired.every(success);
  const fullTupleComplete = minimalCoreComplete && configExtensionComplete;
  const coreTupleDigestId = digestId("core", core.map(fieldDigestRow));
  const configTupleDigestId = digestId("config", configRequired.map(fieldDigestRow));
  const fullTupleDigestId = digestId("full", { coreTupleDigestId, configTupleDigestId });
  return {
    ...provider,
    sourceTupleDigestIds,
    stateFieldOutcomes,
    minimalCoreComplete,
    configExtensionComplete,
    fullTupleComplete,
    coreTupleDigestId,
    configTupleDigestId,
    fullTupleDigestId,
    digestSchemaId: DIGEST_SCHEMA,
    priorDigestIdsReused: false,
  };
}

function buildDiagnostics(providers) {
  const byField = new Map();
  for (const provider of providers) for (const field of provider.stateFieldOutcomes) {
    if (field.applicability === "not-applicable" || success(field)) continue;
    const rows = byField.get(field.field) || [];
    rows.push({ family: provider.providerFamilyId, outcome: field.outcome });
    byField.set(field.field, rows);
  }
  return [...byField.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([field, failures]) => {
    const categories = {};
    for (const category of [...new Set(failures.map((item) => item.outcome))].sort()) {
      const rows = failures.filter((item) => item.outcome === category);
      categories[category] = { providerCount: rows.length, providerFamilyGroupCount: new Set(rows.map((item) => item.family)).size };
    }
    const affectedProviderFamilyGroupCount = new Set(failures.map((item) => item.family)).size;
    return { field, categories, affectedProviderCount: failures.length, affectedProviderFamilyGroupCount, failureCategoryAgreesAcrossFamilies: affectedProviderFamilyGroupCount >= 2 && Object.keys(categories).length === 1 };
  });
}

function incidenceSummary(diagnostics) {
  const categories = [...new Set(diagnostics.flatMap((row) => Object.keys(row.categories)))].sort();
  return categories.map((category) => ({
    category,
    fieldCount: diagnostics.filter((row) => row.categories[category]).length,
    providerFieldIncidenceCount: diagnostics.reduce((n, row) => n + (row.categories[category]?.providerCount || 0), 0),
    providerFamilyFieldIncidenceCount: diagnostics.reduce((n, row) => n + (row.categories[category]?.providerFamilyGroupCount || 0), 0),
    crossFamilyAgreementFieldCount: diagnostics.filter((row) => row.failureCategoryAgreesAcrossFamilies && row.categories[category]).length,
  }));
}

function familyCount(providers, completeKey) {
  return new Set(providers.filter((provider) => eligible(provider, completeKey)).map((provider) => provider.providerFamilyId)).size;
}

function maxConsensus(providers, tupleKey, completeKey) {
  const groups = new Map();
  for (const provider of providers.filter((row) => eligible(row, completeKey) && row.anchorWindowHistoryNonEmpty && row.anchorWindowDigestId)) {
    const key = `${provider[tupleKey]}:${provider.anchorWindowDigestId}`;
    const families = groups.get(key) || new Set(); families.add(provider.providerFamilyId); groups.set(key, families);
  }
  return Math.max(0, ...[...groups.values()].map((families) => families.size));
}

function maxAnchorConsensus(providers) {
  const groups = new Map();
  for (const provider of providers.filter((row) => row.exactRetainedPin && row.retainedHashStable && row.finalizedHeightBound && row.anchorWindowHistoryNonEmpty && row.anchorWindowDigestId)) {
    const families = groups.get(provider.anchorWindowDigestId) || new Set(); families.add(provider.providerFamilyId); groups.set(provider.anchorWindowDigestId, families);
  }
  return Math.max(0, ...[...groups.values()].map((families) => families.size));
}

function transformChain(source) {
  const providers = source.providers.map(normalizeProvider);
  const fieldDiagnostics = buildDiagnostics(providers);
  const minimalCoreConsensusProviderFamilyGroups = maxConsensus(providers, "coreTupleDigestId", "minimalCoreComplete");
  const configExtensionConsensusProviderFamilyGroups = maxConsensus(providers, "configTupleDigestId", "configExtensionComplete");
  const fullTupleConsensusProviderFamilyGroups = maxConsensus(providers, "fullTupleDigestId", "fullTupleComplete");
  const metrics = {
    ...source.metrics,
    minimalCoreComplete: providers.filter((row) => row.minimalCoreComplete).length,
    configExtensionComplete: providers.filter((row) => row.configExtensionComplete).length,
    fullTupleComplete: providers.filter((row) => row.fullTupleComplete).length,
    coreTupleDigestEqualityEligibleProviderFamilyGroups: familyCount(providers, "minimalCoreComplete"),
    configTupleDigestEqualityEligibleProviderFamilyGroups: familyCount(providers, "configExtensionComplete"),
    fullTupleDigestEqualityEligibleProviderFamilyGroups: familyCount(providers, "fullTupleComplete"),
    anchorWindowDigestEqualityProviderFamilyGroups: maxAnchorConsensus(providers),
    minimalCoreConsensusProviderFamilyGroups,
    configExtensionConsensusProviderFamilyGroups,
    fullTupleConsensusProviderFamilyGroups,
  };
  const readiness = {
    minimalCoreProviderFamilyConsensusReady: minimalCoreConsensusProviderFamilyGroups >= 2,
    configExtensionProviderFamilyConsensusReady: configExtensionConsensusProviderFamilyGroups >= 2,
    fullTupleProviderFamilyConsensusReady: fullTupleConsensusProviderFamilyGroups >= 2,
  };
  return {
    ...source,
    metrics,
    readiness,
    fieldDiagnostics,
    providers,
    abiNormalization: {
      schemaId: CONFIG_SCHEMA,
      receiveType1NotApplicableCount: providers.reduce((n, provider) => n + provider.stateFieldOutcomes.filter((field) => field.tier === "config" && field.libraryDirection === "receive" && field.configType === 1 && field.applicability === "not-applicable").length, 0),
      receiveType1ExcludedFromCompletenessAndDiagnostics: true,
      sendRequiredConfigTypes: [1, 2],
      receiveRequiredConfigTypes: [2],
      unsupportedOrAmbiguousFailClosed: true,
    },
    failureCategorySummary: incidenceSummary(fieldDiagnostics),
    failureSummaryCountSemanticsWarning: WARNING,
    initialProbeStatusCategoriesExcludedFromStateAndReadiness: true,
    endpointValuesPersisted: false,
    providerFamilyNamesPersisted: false,
    backendOrOperatorIndependenceClaimed: false,
  };
}

function main() {
  const generatedAt = new Date().toISOString(); const scanner = hashFile(SCANNER);
  const r4RawRecord = hashFile(R4_INPUT_RAW); const r4ManifestRecord = hashFile(R4_INPUT_MANIFEST);
  const r4 = JSON.parse(fs.readFileSync(abs(R4_INPUT_RAW), "utf8")); const r4Manifest = JSON.parse(fs.readFileSync(abs(R4_INPUT_MANIFEST), "utf8"));
  if (r4.revision !== R4_REVISION || r4Manifest.revision !== R4_REVISION || r4.runId !== r4Manifest.runId) throw new Error("immutable-r4-input-mismatch");
  const r4RawManifestRow = r4Manifest.records.find((row) => row.path === RAW);
  if (!r4RawManifestRow || r4RawManifestRow.bytes !== r4RawRecord.bytes || r4RawManifestRow.sha256 !== r4RawRecord.sha256) throw new Error("immutable-r4-byte-binding-mismatch");
  const optimism = transformChain(r4.optimism); const hyperevm = transformChain(r4.hyperevm);
  if (optimism.metrics.configExtensionComplete !== 3 || optimism.metrics.fullTupleComplete !== 2 || optimism.metrics.configExtensionConsensusProviderFamilyGroups !== 3 || optimism.metrics.fullTupleConsensusProviderFamilyGroups !== 2 || !optimism.readiness.configExtensionProviderFamilyConsensusReady || !optimism.readiness.fullTupleProviderFamilyConsensusReady) throw new Error("optimism-corrected-observations-mismatch");
  if (hyperevm.metrics.observedProviderFamilyGroups !== 1 || hyperevm.metrics.configExtensionComplete !== 1 || hyperevm.metrics.fullTupleComplete !== 1 || hyperevm.metrics.configExtensionConsensusProviderFamilyGroups !== 1 || hyperevm.metrics.fullTupleConsensusProviderFamilyGroups !== 1 || hyperevm.readiness.configExtensionProviderFamilyConsensusReady || hyperevm.readiness.fullTupleProviderFamilyConsensusReady) throw new Error("hyperevm-corrected-observations-mismatch");
  const disposition = {
    optimism: "ABI-CORRECTED/THREE-FAMILY-CONFIG-CONSENSUS/TWO-FAMILY-FULL-TUPLE-PLUS-BOUNDED-ANCHOR-CONSENSUS",
    hyperevm: "ABI-CORRECTED/ONE-FAMILY-CONFIG-AND-FULL-OBSERVATION/CONSENSUS-BLOCKED/NO-SECOND-FAMILY-IN-R3-TESTED-INVENTORY-SNAPSHOT",
    overall: CLASSIFICATION,
  };
  const nextAction = "Obtain separately authorized access to a declared second HyperEVM provider family and run a new fixed-pin read-only coverage package using the r6 ABI schema; economics remains blocked until two-family HyperEVM full-tuple plus bounded anchor-window consensus.";
  const transformed = { optimism, hyperevm, graphql: r4.graphql, disposition, abiModel: ABI_MODEL, digestSchemaId: DIGEST_SCHEMA, r4Input: { raw: r4RawRecord, manifest: r4ManifestRecord } };
  const runId = `etherfi-behype-endpoint-coverage-r6-${sha(canonical(transformed)).slice(0, 16)}-${scanner.sha256.slice(0, 12)}`;
  const provenance = {
    derivedFromImmutableR4Inputs: true,
    sourceR4RunId: r4.runId,
    sourceR4Revision: r4.revision,
    sourceR4ManifestAggregateSha256: r4Manifest.aggregateSha256,
    r4WasOfflineDiagnosticDerivationOfR3TestedSnapshot: true,
    supersedesR5: { runId: R5_RUN, revision: R5_REVISION, manifestAggregateSha256: R5_MANIFEST_AGGREGATE, reason: "receive-side ULN302 config type 1 was incorrectly treated as required" },
    r5ObservationSourceWasSameImmutableR4Snapshot: true,
    originalR3MutableArtifactsAvailable: false,
    independentlyReproducibleR3SourceAggregateClaimed: false,
    r3ProvenanceStatus: "UNAVAILABLE/ORIGINAL-MUTABLE-R3-FILES-OVERWRITTEN",
  };
  const result = {
    schemaVersion: 2, revision: REVISION, runId, generatedAt, scanner: SCANNER, agentId: AGENT, role: "critical-research", classification: CLASSIFICATION,
    severity: "Informational", defectType: "audit-tooling-false-coverage-negative", protocolVulnerability: false,
    routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    safety: { offlineOnly: true, endpointInventoriesReadThisRun: false, networkCalls: false, inventoryFilesModified: false, endpointValuesPersisted: false, providerDomainsPersisted: false, providerSecretIdentifiersPersisted: false, rawInventoryLinesPersisted: false, economicsCalls: false, ethSendMethodsUsed: false, signingUsed: false, forkCreated: false, stateMutation: false },
    immutableInputs: { r4Raw: r4RawRecord, r4Manifest: r4ManifestRecord, copiedByteForByteBeforeMutableOverwrite: true },
    officialLayerZeroReference: { commit: LZ_COMMIT, sourceRecords: LZ_SOURCES.map(hashFile), networkReadThisRun: false },
    abiModel: ABI_MODEL,
    digestSchema: { schemaId: DIGEST_SCHEMA, algorithm: "sha256", priorDigestIdsReused: false, rawValuesAvailable: false, inputRowsUseRetainedAnonymousValueDigestIds: true },
    provenance,
    inventory: r4.inventory, optimism, hyperevm, graphql: r4.graphql,
    providerFamilyConsensusReadiness: { optimism: optimism.readiness, hyperevm: hyperevm.readiness, bothFullTuple: optimism.readiness.fullTupleProviderFamilyConsensusReady && hyperevm.readiness.fullTupleProviderFamilyConsensusReady },
    disposition, failureSummaryCountSemanticsWarning: WARNING,
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, nextReadOnlyStep: nextAction,
  };
  writeOwned(RAW, JSON.stringify(result, null, 2) + "\n");
  const summaryText = (row) => row.failureCategorySummary.map((item) => `${item.category}: fields=${item.fieldCount}, provider-field incidences=${item.providerFieldIncidenceCount}, provider-family-field incidences=${item.providerFamilyFieldIncidenceCount}, agreed-fields=${item.crossFamilyAgreementFieldCount}`).join("; ") || "none";
  const report = [
    "# 🟠 WATCH — INFORMATIONAL TOOLING DEFECT CORRECTED / HYPEREVM COVERAGE OPEN — EtherFi BeHYPE r6", "",
    `**Run:** \`${runId}\`  `, `**Revision:** \`${REVISION}\`  `, `**Classification:** \`${CLASSIFICATION}\`  `, "**Severity:** `Informational` — scanner false-negative; not a protocol vulnerability  ", "**Gates:** `0/0/false`; `fork=false`", "",
    "This package derives only from immutable byte-bound r4 observations underlying r5. No endpoint inventory or network reads occurred. R6 supersedes r5 config-readiness wording.", "",
    "## ABI correction", "",
    "- `getSendLibrary(address,uint32)` returns one address; send ULN302 requires config types 1 (`ExecutorConfig`) and 2 (`UlnConfig`).",
    "- `getReceiveLibrary(address,uint32)` returns `(address,bool)`; receive ULN302 requires only type 2. Receive type 1 is explicitly not applicable and deterministically reverts `LZ_ULN_InvalidConfigType(uint32)`.",
    "- `getConfig(address,address,uint32,uint32)` returns a dynamic `bytes` ABI envelope. R6 records envelope/schema/version metadata but does not invent unavailable payload bytes, library addresses, or live version outputs.",
    "- Unsupported or ambiguous library kind/version/config type is fail-closed. New schema-versioned SHA-256 tuple digests were computed from retained anonymous observations; no r4/r5 tuple digest ID was reused.", "",
    "## Corrected disposition", "",
    `- Optimism: ${disposition.optimism}.`, `- HyperEVM: ${disposition.hyperevm}.`,
    "- HyperEVM remains below the two-family threshold; economics remains blocked.", "",
    "## Core/config/full counts", "",
    "| Chain | Correct chain | Core complete | Config complete | Full complete | Anchor-window non-empty | Families | Core consensus | Config consensus | Full consensus |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| Optimism | ${optimism.metrics.correctChain} | ${optimism.metrics.minimalCoreComplete} | ${optimism.metrics.configExtensionComplete} | ${optimism.metrics.fullTupleComplete} | ${optimism.metrics.anchorWindowHistoryNonEmpty} | ${optimism.metrics.observedProviderFamilyGroups} | ${optimism.metrics.minimalCoreConsensusProviderFamilyGroups} | ${optimism.metrics.configExtensionConsensusProviderFamilyGroups} | ${optimism.metrics.fullTupleConsensusProviderFamilyGroups} |`,
    `| HyperEVM | ${hyperevm.metrics.correctChain} | ${hyperevm.metrics.minimalCoreComplete} | ${hyperevm.metrics.configExtensionComplete} | ${hyperevm.metrics.fullTupleComplete} | ${hyperevm.metrics.anchorWindowHistoryNonEmpty} | ${hyperevm.metrics.observedProviderFamilyGroups} | ${hyperevm.metrics.minimalCoreConsensusProviderFamilyGroups} | ${hyperevm.metrics.configExtensionConsensusProviderFamilyGroups} | ${hyperevm.metrics.fullTupleConsensusProviderFamilyGroups} |`, "",
    "## Qualifications", "",
    `- Optimism diagnostics: ${summaryText(optimism)}.`, `- HyperEVM diagnostics: ${summaryText(hyperevm)}.`, `- ${WARNING}`,
    "- Receive type 1 is excluded from completeness and diagnostics. Other retained failures remain fail-closed.",
    "- Original mutable r3 artifacts remain unavailable. No independently reproducible r3 aggregate is claimed. Provider-family labels are anonymous, backend/operator independence is not claimed, anchor history is bounded, finality qualifications are preserved, and GraphQL remains protocol-response-only.", "",
    `**nextReadOnlyStep:** ${nextAction}`,
  ].join("\n") + "\n";
  writeOwned(REPORT, report);
  const inbox = { findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: CLASSIFICATION, classification: CLASSIFICATION, severity: "Informational", protocolVulnerability: false, toolingDefectCorrected: true, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, correctedMetrics: { optimism: optimism.metrics, hyperevm: hyperevm.metrics }, disposition, readiness: result.providerFamilyConsensusReadiness, immutableInputs: result.immutableInputs, officialLayerZeroCommit: LZ_COMMIT, abiSchemaId: CONFIG_SCHEMA, digestSchemaId: DIGEST_SCHEMA, failureSummaryCountSemanticsWarning: WARNING, failureCategorySummary: { optimism: optimism.failureCategorySummary, hyperevm: hyperevm.failureCategorySummary }, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R4_INPUT_RAW, R4_INPUT_MANIFEST, ...LZ_SOURCES], nextAction };
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  const handoff = ["# EtherFi BeHYPE endpoint config ABI correction r6 handoff", "", `- Run \`${runId}\`; classification \`${CLASSIFICATION}\`; severity Informational; tooling false-negative only, not a protocol vulnerability.`, `- LayerZero official source commit \`${LZ_COMMIT}\`: send library return is address, receive return is address plus default boolean; send ULN302 types 1/2; receive ULN302 type 2 only.`, `- Immutable r4 inputs: \`${R4_INPUT_RAW}\` (${r4RawRecord.bytes} bytes) and \`${R4_INPUT_MANIFEST}\` (${r4ManifestRecord.bytes} bytes); hashes retained in raw/manifest.`, `- Optimism corrected metrics core/config/full complete \`${optimism.metrics.minimalCoreComplete}/${optimism.metrics.configExtensionComplete}/${optimism.metrics.fullTupleComplete}\`; consensus families \`${optimism.metrics.minimalCoreConsensusProviderFamilyGroups}/${optimism.metrics.configExtensionConsensusProviderFamilyGroups}/${optimism.metrics.fullTupleConsensusProviderFamilyGroups}\`; config/full readiness true/true.`, `- HyperEVM corrected metrics core/config/full complete \`${hyperevm.metrics.minimalCoreComplete}/${hyperevm.metrics.configExtensionComplete}/${hyperevm.metrics.fullTupleComplete}\`; consensus families \`${hyperevm.metrics.minimalCoreConsensusProviderFamilyGroups}/${hyperevm.metrics.configExtensionConsensusProviderFamilyGroups}/${hyperevm.metrics.fullTupleConsensusProviderFamilyGroups}\`; all readiness false because only one family exists.`, "- Receive type 1 is not applicable and excluded from completeness/diagnostics. Dynamic bytes/schema/version metadata is explicit; unavailable raw values were not fabricated; unknown kind/version fails closed.", `- ${WARNING}`, "- Original r3 mutable provenance remains unavailable; no independent r3 aggregate or backend/operator independence claim. Anchor-window/finality/GraphQL qualifications remain bounded.", "- Offline only; no inventory/network/economics/transaction/signing/fork/mutation.", `- Next: ${nextAction}`].join("\n") + "\n";
  writeOwned(HANDOFF, handoff);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R4_INPUT_RAW, R4_INPUT_MANIFEST, ...LZ_SOURCES].map(hashFile); const aggregateSha256 = sha(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"));
  const manifest = { schemaVersion: 2, revision: REVISION, runId, generatedAt, classification: CLASSIFICATION, severity: "Informational", protocolVulnerability: false, algorithm: "sha256", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, offlineOnly: true, endpointInventoriesReadThisRun: false, immutableInputs: result.immutableInputs, officialLayerZeroReference: result.officialLayerZeroReference, abiSchemaId: CONFIG_SCHEMA, digestSchema: result.digestSchema, provenance, correctedMetrics: { optimism: optimism.metrics, hyperevm: hyperevm.metrics }, providerFamilyConsensusReadiness: result.providerFamilyConsensusReadiness, disposition, failureSummaryCountSemanticsWarning: WARNING, endpointValuesPersisted: false, backendOrOperatorIndependenceClaimed: false, records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, classification: CLASSIFICATION, correctedMetrics: { optimism: { coreComplete: optimism.metrics.minimalCoreComplete, configComplete: optimism.metrics.configExtensionComplete, fullComplete: optimism.metrics.fullTupleComplete, coreConsensus: optimism.metrics.minimalCoreConsensusProviderFamilyGroups, configConsensus: optimism.metrics.configExtensionConsensusProviderFamilyGroups, fullConsensus: optimism.metrics.fullTupleConsensusProviderFamilyGroups }, hyperevm: { coreComplete: hyperevm.metrics.minimalCoreComplete, configComplete: hyperevm.metrics.configExtensionComplete, fullComplete: hyperevm.metrics.fullTupleComplete, coreConsensus: hyperevm.metrics.minimalCoreConsensusProviderFamilyGroups, configConsensus: hyperevm.metrics.configExtensionConsensusProviderFamilyGroups, fullConsensus: hyperevm.metrics.fullTupleConsensusProviderFamilyGroups } }, manifestAggregateSha256: aggregateSha256, gates: result.gates, nextReadOnlyStep: nextAction }) + "\n");
}

try { main(); } catch { process.stderr.write("offline ABI-correction packaging failed: sanitized internal error\n"); process.exitCode = 1; }
