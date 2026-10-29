#!/usr/bin/env node
"use strict";

// Unit / Hyperunit step-5 bounded source/build or bytecode-metadata semantic comparison.
// Deterministic local artifact reduction plus static recorded public research facts only.

const fs = require("fs");
const path = require("path");
const {
  FRESHNESS_POLICY,
  buildIntegrityCheckpoint,
  buildOperationalOutputSummary,
  deriveUnitRouteSummary,
  implementationCoverage,
  loadArtifactManifest,
} = require("./lib/unit-audit-integrity");

const WORKSPACE = path.resolve(__dirname, "..");
const SCANNER = "tools/scan-unit-source-build-bytecode-semantics.js";
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "unit-source-build-bytecode-semantics.json");
const OUT_MD = path.join(WORKSPACE, "reports", "unit-source-build-bytecode-semantics-triage.md");

const ALLOWED_WRITES = new Set([
  "reports/raw/fast/unit-source-build-bytecode-semantics.json",
  "reports/unit-source-build-bytecode-semantics-triage.md",
]);

const SOURCE_ARTIFACTS = [
  "reports/raw/fast/unit-static-implementation-upgrade.json",
  "reports/raw/fast/unit-implementation-reserve-discovery.json",
  "reports/raw/fast/unit-proof-custody-accounting.json",
  "reports/raw/fast/unit-readonly-discovery.json",
  "reports/raw/fast/hyperliquid-core-dex-depth-routes.json",
];

const SOURCE_ARTIFACT_SPECS = SOURCE_ARTIFACTS.map((artifactPath) => ({
  path: artifactPath,
  required: true,
  evidenceClass: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json") ? "marketEconomics" : "derived",
  requiredPaths: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json")
    ? ["generatedAt", "rows"]
    : ["generatedAt", artifactPath.endsWith("unit-static-implementation-upgrade.json") ? "implementationSnapshots" : (artifactPath.endsWith("unit-implementation-reserve-discovery.json") ? "publicContractRows" : (artifactPath.endsWith("unit-proof-custody-accounting.json") ? "custodyReconciliationRows" : "unitAssetRows"))],
  requiredTypes: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json") ? { rows: "array" } : {},
}));

const STATIC_SOURCE_URLS = {
  uethExplorer: "https://hyperevmscan.io/address/0xE60DD45EBa5655e31CA1E61BEad4f983B3C4A83B",
  usolExplorer: "https://hyperevmscan.io/address/0xaB73C0Ab9E4b931769373bd0C6480c022119D74c",
  explorerLegacySourceApiTemplate: "https://api.hyperevmscan.io/api?module=contract&action=getsourcecode&address=...",
  sourcifyFullMatchTemplate: "https://repo.sourcify.dev/contracts/full_match/999/<address>/metadata.json",
  unitTokenMetadata: "https://docs.hyperunit.xyz/developers/key-addresses/mainnet/token-metadata.md",
};

const TARGETS = [
  {
    symbol: "UETH",
    expectedName: "UnitEthereum",
    chain: "HyperEVM",
    chainId: 999,
    implementationAddress: "0xE60DD45EBa5655e31CA1E61BEad4f983B3C4A83B",
  },
  {
    symbol: "USOL",
    expectedName: "UnitSolana",
    chain: "HyperEVM",
    chainId: 999,
    implementationAddress: "0xaB73C0Ab9E4b931769373bd0C6480c022119D74c",
  },
];

const RECORDED_METHODS = [
  "name", "symbol", "decimals", "totalSupply", "balanceOf", "allowance", "transfer", "transferFrom", "approve",
  "owner", "transferOwnership", "renounceOwnership",
  "complianceAuthority", "transferComplianceAuthority", "addToBlacklist", "removeFromBlacklist", "isBlacklisted",
  "upgradeToAndCall", "proxiableUUID", "UPGRADE_INTERFACE_VERSION", "hyperCoreDeployer", "initialize",
];

const RECORDED_EVENTS = [
  "Transfer", "Approval", "OwnershipTransferred", "ComplianceAuthorityTransferred", "AddedToBlacklist",
  "RemovedFromBlacklist", "Initialized", "Upgraded",
];

const SEMANTIC_PROPERTIES = [
  { property: "inheritance clauses", reason: "full source text unavailable" },
  { property: "source/import graph", reason: "standard-json input and source bundle unavailable" },
  { property: "initializer body and role assignment", reason: "function body unavailable" },
  { property: "constructor _disableInitializers", reason: "implementation source body unavailable" },
  { property: "blacklist enforcement in transfer/update path", reason: "ABI names do not establish internal call flow" },
  { property: "decimals return value", reason: "no decimals call and no source body" },
  { property: "hyperCoreDeployer assignment and use", reason: "getter name does not establish semantics" },
  { property: "_authorizeUpgrade gate", reason: "authorization body and modifiers unavailable" },
  { property: "issuance mechanism", reason: "no explicit mint/burn names recorded, but alternate issuance paths cannot be excluded" },
  { property: "receive/fallback behavior", reason: "not represented in recorded ABI and source unavailable" },
];

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function assertAllowedWrite(file) {
  const relative = rel(path.resolve(file));
  if (!ALLOWED_WRITES.has(relative)) throw new Error(`Refusing to write outside Unit step-5 ownership: ${relative}`);
}

function writeAllowed(file, content) {
  assertAllowedWrite(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function md(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function fmtUsd(value) {
  if (value == null || value === "") return "n/a";
  const n = Number(value);
  if (!Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(3)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(4)}`;
}

function normalizedList(values) {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
}

function readJsonArtifact(relPath) {
  const file = path.join(WORKSPACE, relPath);
  const info = {
    path: relPath,
    present: false,
    read: false,
    parseOk: false,
    generatedAt: null,
    scanner: null,
    scope: null,
    routePositive: null,
    executableNow: null,
    signedActionJustified: null,
    summary: null,
    error: null,
  };
  try {
    if (!fs.existsSync(file)) return { info, json: null };
    info.present = true;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    info.read = true;
    info.parseOk = true;
    info.generatedAt = json.generatedAt || json.scannedAt || null;
    info.scanner = json.scanner || null;
    info.scope = typeof json.scope === "string" ? json.scope : null;
    const summary = json.summary || {};
    const safety = json.safety || {};
    info.routePositive = summary.routePositive ?? safety.routePositive ?? json.routePositive ?? null;
    info.executableNow = summary.executableNow ?? safety.executableNow ?? json.executableNow ?? null;
    info.signedActionJustified = summary.signedActionJustified ?? safety.signedActionJustified ?? json.signedActionJustified ?? null;
    info.summary = pick(summary, ["targetsScanned", "depthAvailable", "exactDexQuoteRows", "bestExactNetUsd", "routePositive"]);
    if (relPath.endsWith("unit-static-implementation-upgrade.json")) {
      info.summary = {
        implementationSnapshots: Array.isArray(json.implementationSnapshots) ? json.implementationSnapshots.length : null,
        commonMethods: json.abiMethodMatrix && Array.isArray(json.abiMethodMatrix.commonMethods) ? json.abiMethodMatrix.commonMethods.length : null,
        commonEvents: json.eventMatrix && Array.isArray(json.eventMatrix.commonEvents) ? json.eventMatrix.commonEvents.length : null,
        sourceBodiesCompared: json.staticSemanticComparison && json.staticSemanticComparison.sourceBodiesCompared,
        bytecodeCompared: json.staticSemanticComparison && json.staticSemanticComparison.bytecodeCompared,
        routePositive: json.routePositive ?? 0,
      };
    }
    if (relPath.endsWith("unit-implementation-reserve-discovery.json")) {
      info.summary = {
        publicContractRows: Array.isArray(json.publicContractRows) ? json.publicContractRows.length : null,
        reconciliationStatus: json.reserveLiabilityVisibility && json.reserveLiabilityVisibility.reconciliationStatus,
        routePositive: json.routePositive ?? 0,
      };
    }
    if (relPath.endsWith("unit-proof-custody-accounting.json")) {
      info.summary = {
        custodyReconciliationRows: Array.isArray(json.custodyReconciliationRows) ? json.custodyReconciliationRows.length : null,
        routePositive: json.routePositive ?? 0,
      };
    }
    if (relPath.endsWith("unit-readonly-discovery.json")) {
      info.summary = {
        unitAssetRows: Array.isArray(json.unitAssetRows) ? json.unitAssetRows.length : null,
        consumerJoins: json.consumerJoinSummary && json.consumerJoinSummary.hyperliquidLinkedTokenConsumers && json.consumerJoinSummary.hyperliquidLinkedTokenConsumers.consumerJoins,
        bestExactNetUsd: json.economicsSummary && json.economicsSummary.bestExactNetUsd,
        routePositive: json.routePositive ?? 0,
      };
    }
    return { info, json };
  } catch (err) {
    info.present = fs.existsSync(file);
    info.error = err && err.message ? err.message : String(err);
    return { info, json: null };
  }
}

function step4Fingerprint(step4Json) {
  return step4Json && step4Json.abiMethodMatrix && step4Json.abiMethodMatrix.normalizedStaticFingerprintSha256
    ? step4Json.abiMethodMatrix.normalizedStaticFingerprintSha256
    : null;
}

function buildTargetRows() {
  return TARGETS.map((target) => ({
    ...target,
    explorerVerificationRecorded: "source-code-verified-exact-match",
    independentlyReproduced: false,
    fullSourceTextAvailable: false,
    standardJsonInputAvailable: false,
    runtimeBytecodeAvailable: false,
    creationBytecodeAvailable: false,
    sourceEqualityDetermined: false,
    runtimeEqualityDetermined: false,
    routePositive: 0,
  }));
}

function buildRetrievalAvailabilityRows() {
  const rows = [];
  for (const target of TARGETS) {
    rows.push(
      {
        symbol: target.symbol,
        source: "HyperEVMScan address page",
        availability: "available-static-page-facts",
        sourceCodeStatus: "exact-match-verified-recorded",
        fullSourceRetrieved: false,
        independentlyReproduced: false,
        caveat: "Compiler/settings and ABI name-level facts recorded; full source text was not retrievable in reviewed output.",
      },
      {
        symbol: target.symbol,
        source: "HyperEVMScan legacy API V1",
        availability: "deprecated-v1-no-source-returned",
        sourceCodeStatus: "unavailable-from-reviewed-v1-response",
        fullSourceRetrieved: false,
        independentlyReproduced: false,
        caveat: "Legacy API returned a V1 deprecation notice.",
      },
      {
        symbol: target.symbol,
        source: "Etherscan-compatible API V2",
        availability: "api-key-workflow-not-used",
        sourceCodeStatus: "not-retrieved",
        fullSourceRetrieved: false,
        independentlyReproduced: false,
        caveat: "V2/API-key workflow was outside this deterministic no-network scanner.",
      },
      {
        symbol: target.symbol,
        source: "Sourcify full_match metadata",
        availability: "temporarily-unavailable-503",
        sourceCodeStatus: "unknown-not-no-match",
        fullSourceRetrieved: false,
        independentlyReproduced: false,
        caveat: "Service returned HTTP 503 in reviewed public research; treat as temporary coverage caveat, not no-match.",
      },
      {
        symbol: target.symbol,
        source: "Official Unit docs",
        availability: "token-metadata-only-no-solidity-build-reference",
        sourceCodeStatus: "not-established",
        fullSourceRetrieved: false,
        independentlyReproduced: false,
        caveat: "Official docs provide token metadata but no Solidity source/build reference.",
      }
    );
  }
  return rows;
}

function buildMetadataRows(step4Json) {
  const fingerprint = step4Fingerprint(step4Json);
  return TARGETS.map((target) => ({
    symbol: target.symbol,
    implementationAddress: target.implementationAddress,
    recordedVerification: "source-code-verified-exact-match",
    independentlyReproduced: false,
    compiler: "v0.8.28+commit.7893614a",
    evmVersion: "Paris",
    optimizer: { enabled: false, runsDisplayed: 200, displayCaveat: "Explorer displays 'No with 200 runs'; no standard-json input was retrieved to reproduce settings." },
    license: "-NA-",
    fullSourceTextAvailable: false,
    standardJsonInputAvailable: false,
    librariesAvailable: false,
    constructorArgumentsAvailable: false,
    storageLayoutAvailable: false,
    fullAbiJsonAvailable: false,
    canonicalSignaturesAvailable: false,
    abiStaticNamesFingerprintSha256: fingerprint,
    fingerprintLabel: "static-recorded-abi-fingerprint-not-runtime-proof",
    routePositive: 0,
  }));
}

function buildBytecodeMetadataRows() {
  return TARGETS.map((target) => ({
    symbol: target.symbol,
    implementationAddress: target.implementationAddress,
    runtimeBytecode: null,
    runtimeBytecodeLengthBytes: null,
    runtimeBytecodeHashSha256: null,
    runtimeBytecodeKeccak256: null,
    creationBytecode: null,
    creationBytecodeLengthBytes: null,
    creationBytecodeHashSha256: null,
    creationBytecodeKeccak256: null,
    cborMetadataTrailer: null,
    metadataHash: null,
    ipfsCid: null,
    swarmHash: null,
    immutableReferences: null,
    linkReferences: null,
    availability: "unavailable-not-retrieved",
    independentlyReproduced: false,
    equalityComparisonPossible: false,
    caveat: "No bytecode or metadata trailer was fetched or reconstructed; no hashes or lengths are fabricated.",
    routePositive: 0,
  }));
}

function buildAbiComparison(step4Json) {
  const methods = step4Json && step4Json.abiMethodMatrix && Array.isArray(step4Json.abiMethodMatrix.commonMethods)
    ? step4Json.abiMethodMatrix.commonMethods
    : RECORDED_METHODS;
  const events = step4Json && step4Json.eventMatrix && Array.isArray(step4Json.eventMatrix.commonEvents)
    ? step4Json.eventMatrix.commonEvents
    : RECORDED_EVENTS;
  return {
    comparisonAuthority: "recorded-public-abi-names-only",
    inputIndependence: "names-only-circular-input-from-step-4-recorded-context",
    independentSemanticProof: false,
    semanticEvidenceStatus: "unknown",
    commonMethods: normalizedList(methods),
    commonEvents: normalizedList(events),
    onlyUethMethods: [],
    onlyUsolMethods: [],
    onlyUethEvents: [],
    onlyUsolEvents: [],
    canonicalFullSignatureComparisonAvailable: false,
    parameterTypesCompared: false,
    returnTypesCompared: false,
    eventIndexedFieldsCompared: false,
    customErrorsCompared: false,
    explicitPublicMintBurnMethodNames: [],
    mintBurnCaveat: "No explicit public mint/burn method names were recorded; do not infer no issuance path.",
    abiStaticNamesFingerprintSha256: step4Fingerprint(step4Json),
    fingerprintLabel: "static-recorded-abi-fingerprint-not-runtime-proof",
    runtimeProof: false,
    conclusion: "UETH and USOL share recorded method/event names only; circular names-only input cannot prove equivalence and semantic status remains unknown.",
    routePositive: 0,
  };
}

function buildSourceSemanticMatrix() {
  return SEMANTIC_PROPERTIES.map((item) => ({
    property: item.property,
    uethStatus: "unavailable-not-compared",
    usolStatus: "unavailable-not-compared",
    equalityDetermined: false,
    reason: item.reason,
    vulnerabilityConclusion: "unknown",
    routePositive: 0,
  }));
}

function buildStorageLayoutComparison() {
  return {
    uethStorageLayoutAvailable: false,
    usolStorageLayoutAvailable: false,
    standardJsonStorageLayoutsAvailable: false,
    slotMapsAvailable: false,
    variableOrderCompared: false,
    inheritedStorageCompared: false,
    gapsCompared: false,
    namespacesCompared: false,
    proxyCompatibilityCompared: false,
    equalityDetermined: false,
    status: "unavailable-not-compared",
    conclusion: "Storage-layout equivalence and upgrade compatibility cannot be determined without source/build output or independently retrieved layout metadata.",
    routePositive: 0,
  };
}

function buildSourcifyStatusRows() {
  return TARGETS.map((target) => ({
    symbol: target.symbol,
    chainId: target.chainId,
    address: target.implementationAddress,
    requestedPathPattern: `contracts/full_match/${target.chainId}/${target.implementationAddress}/metadata.json`,
    reviewedStatus: "temporarily-unavailable-503",
    matchConclusion: "unknown-not-no-match",
    fetchedByScanner: false,
    caveat: "HTTP 503 is a temporary service availability caveat and must not be interpreted as a Sourcify no-match.",
  }));
}

function buildLocalEconomicsCarryForward(artifacts, routeSummary) {
  const step1 = artifacts["reports/raw/fast/unit-readonly-discovery.json"].json;
  const step3 = artifacts["reports/raw/fast/unit-implementation-reserve-discovery.json"].json;
  const depth = artifacts["reports/raw/fast/hyperliquid-core-dex-depth-routes.json"].json;
  const rows = Array.isArray(step1 && step1.unitAssetRows) ? step1.unitAssetRows : [];
  const summary = depth && depth.summary ? depth.summary : {};
  return {
    systemBalanceExceedsSupply: step1 && step1.sourceArtifacts && step1.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"] && step1.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].summary && step1.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].summary.systemBalanceExceedsSupply,
    consumerJoins: step1 && step1.consumerJoinSummary && step1.consumerJoinSummary.hyperliquidLinkedTokenConsumers && step1.consumerJoinSummary.hyperliquidLinkedTokenConsumers.consumerJoins,
    hyperlendJoins: step1 && step1.consumerJoinSummary && step1.consumerJoinSummary.hyperliquidLinkedTokenConsumers && step1.consumerJoinSummary.hyperliquidLinkedTokenConsumers.hyperlendJoins,
    globalDepthSourceTargetsScannedNotUnitSummary: summary.targetsScanned ?? null,
    bestExactNetUsd: routeSummary.bestExactUnitRoute?.netUsd ?? null,
    bestEstimatedNetUsd: routeSummary.bestEstimatedUnitRoute?.netUsd ?? null,
    reserveLiabilityReconciliationStatus: step3 && step3.reserveLiabilityVisibility && step3.reserveLiabilityVisibility.reconciliationStatus,
    keyAssetEconomics: rows
      .filter((row) => ["UBTC", "UETH", "USOL"].includes(String(row.symbol || "").toUpperCase()))
      .map((row) => ({
        symbol: row.symbol,
        maxDexLiquidityUsd: row.summarizedMetrics && row.summarizedMetrics.maxDexLiquidityUsd,
        maxBorrowCashUsd: row.summarizedMetrics && row.summarizedMetrics.maxBorrowCashUsd,
        bestExactNetUsd: row.summarizedMetrics && row.summarizedMetrics.bestExactNetUsd,
        routePositive: row.summarizedMetrics && row.summarizedMetrics.routePositive ? 1 : 0,
      })),
    canonicalUnitRouteSummary: routeSummary,
    conclusion: "Source/build/bytecode unavailability does not change stale economics or unresolved reserve/liability reconciliation.",
    routePositive: routeSummary.routePositiveOperational,
    executableNow: 0,
    signedActionJustified: false,
  };
}

function renderReport(raw) {
  const lines = [];
  lines.push("# Unit / Hyperunit Source, Build, and Bytecode Semantic Comparison");
  lines.push("");
  lines.push(`Signal: ${raw.operationalOutput.signalLabel} — auditClassification=${raw.auditClassification}, routeEvidenceStatus=${raw.routeEvidenceStatus}, routePositiveOperational=${raw.routePositiveOperational}, executableNow=0, signedActionJustified=false.`);
  lines.push("");
  lines.push("## Scope / Safety");
  lines.push("");
  lines.push(`- Scanner: \`${raw.scanner}\`, generated \`${raw.generatedAt}\`.`);
  lines.push("- Step 5 uses deterministic local reduction and static recorded public research facts only; the scanner made no network or live-state calls.");
  lines.push("- No endpoint inventories, env/key material, API keys, user APIs, role/balance/supply/decimals calls, source-chain queries, transactions, simulations, signing, forks, wallets, endpoint enumeration, or aggregate promotion.");
  lines.push("- Recorded explorer exact-match status was not independently reproduced. Source and bytecode remain unavailable; semantic and vulnerability conclusions remain unknown.");
  lines.push(`- Implementation scope=${raw.implementationCoverage.reviewedProxyCount}/${raw.implementationCoverage.observedProxyCount}; missing=${raw.implementationCoverage.missingProxySymbols.join(", ")}; evidence complete=${raw.evidenceComplete}.`);
  lines.push("");
  lines.push("## Retrieval Availability");
  lines.push("");
  lines.push("| Token | Source | Availability | Full source retrieved | Independently reproduced | Caveat |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of raw.retrievalAvailabilityRows) {
    lines.push(`| ${md(row.symbol)} | ${md(row.source)} | ${md(row.availability)} | ${row.fullSourceRetrieved} | ${row.independentlyReproduced} | ${md(row.caveat)} |`);
  }
  lines.push("");
  lines.push("Sourcify HTTP 503 is recorded as `temporarily-unavailable-503`, not as a no-match.");
  lines.push("");
  lines.push("## Build Metadata");
  lines.push("");
  lines.push("| Token | Recorded verification | Compiler | EVM | Optimizer | License | Reproduced |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const row of raw.buildMetadataRows) {
    lines.push(`| ${md(row.symbol)} | ${md(row.recordedVerification)} | ${md(row.compiler)} | ${md(row.evmVersion)} | enabled=${row.optimizer.enabled}, runsDisplayed=${row.optimizer.runsDisplayed} | ${md(row.license)} | ${row.independentlyReproduced} |`);
  }
  lines.push("");
  lines.push("The explorer display `No with 200 runs` is recorded as optimizer enabled=false with runsDisplayed=200; without standard-json input it was not reproduced.");
  lines.push("");
  lines.push("## Bytecode Metadata");
  lines.push("");
  lines.push("| Token | Runtime bytecode | Creation bytecode | Hashes/lengths | Metadata trailer | Equality possible |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of raw.bytecodeMetadataRows) {
    lines.push(`| ${md(row.symbol)} | ${md(row.availability)} | ${md(row.availability)} | unavailable/null | unavailable/null | ${row.equalityComparisonPossible} |`);
  }
  lines.push("");
  lines.push("No runtime/creation bytecode, lengths, hashes, metadata trailers, IPFS/Swarm references, immutable references, or link references were fabricated.");
  lines.push("");
  lines.push("## ABI Comparison");
  lines.push("");
  lines.push(`- Authority: \`${raw.abiComparison.comparisonAuthority}\`; canonical full-signature comparison available=${raw.abiComparison.canonicalFullSignatureComparisonAvailable}.`);
  lines.push(`- Common recorded method names (${raw.abiComparison.commonMethods.length}): ${raw.abiComparison.commonMethods.join(", ")}.`);
  lines.push(`- Common recorded event names (${raw.abiComparison.commonEvents.length}): ${raw.abiComparison.commonEvents.join(", ")}.`);
  lines.push("- Only-UETH and only-USOL method/event sets are empty at the names-only level. Parameter types, returns, indexed event fields, and custom errors were not compared.");
  lines.push(`- Fingerprint label: \`${raw.abiComparison.fingerprintLabel}\`; runtimeProof=false.`);
  lines.push("- The method/event lists are names-only circular input carried from prior recorded context; they provide no independent semantic-equivalence evidence.");
  lines.push("- Explicit public mint/burn names were not recorded; this does not prove no issuance path.");
  lines.push("");
  lines.push("## Source Semantic Matrix");
  lines.push("");
  lines.push("| Property | UETH | USOL | Equality determined | Reason |");
  lines.push("|---|---|---|---|---|");
  for (const row of raw.sourceSemanticMatrix) {
    lines.push(`| ${md(row.property)} | ${md(row.uethStatus)} | ${md(row.usolStatus)} | ${row.equalityDetermined} | ${md(row.reason)} |`);
  }
  lines.push("");
  lines.push("## Storage Layout");
  lines.push("");
  lines.push(`- Status: \`${raw.storageLayoutComparison.status}\`; equalityDetermined=${raw.storageLayoutComparison.equalityDetermined}.`);
  lines.push(`- ${raw.storageLayoutComparison.conclusion}`);
  lines.push("");
  lines.push("## Comparison Verdict");
  lines.push("");
  lines.push(`- Verdict: \`${raw.comparisonVerdict.verdict}\`.`);
  lines.push(`- ${raw.comparisonVerdict.conclusion}`);
  lines.push("- Same recorded compiler/EVM/optimizer display and ABI name-level surface do not establish source equality, runtime equality, or metadata-only differences.");
  lines.push("");
  lines.push("## Local Economics");
  lines.push("");
  lines.push(`- systemBalanceExceedsSupply=${raw.localEconomicsCarryForward.systemBalanceExceedsSupply ?? "n/a"}; consumerJoins=${raw.localEconomicsCarryForward.consumerJoins ?? "n/a"}; HyperLend joins=${raw.localEconomicsCarryForward.hyperlendJoins ?? "n/a"}.`);
  lines.push(`- Canonical Unit exact best=${raw.localEconomicsCarryForward.bestExactNetUsd ?? "n/a"}; estimated best=${raw.localEconomicsCarryForward.bestEstimatedNetUsd ?? "n/a"}; global source targets (not Unit summary)=${raw.localEconomicsCarryForward.globalDepthSourceTargetsScannedNotUnitSummary ?? "n/a"}; evidence=${raw.routeEvidenceStatus}.`);
  lines.push("| Asset | Max DEX liquidity | Max borrow cash | Best exact net | Route |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const row of raw.localEconomicsCarryForward.keyAssetEconomics) {
    lines.push(`| ${md(row.symbol)} | ${fmtUsd(row.maxDexLiquidityUsd)} | ${fmtUsd(row.maxBorrowCashUsd)} | ${fmtUsd(row.bestExactNetUsd)} | ${row.routePositive ?? 0} |`);
  }
  lines.push(`- ${raw.operationalOutput.narrative}`);
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const blocker of raw.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Required Before Route Positive");
  lines.push("");
  for (const requirement of raw.requiredForRoutePositive) lines.push(`- ${requirement}`);
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("");
  lines.push(`- ${raw.nextReadOnlyStep}`);
  lines.push("");
  lines.push("## Gate Status");
  lines.push("");
  lines.push("No route, executor, fork, transaction, simulation, signed action, route sweep, completion gate, or aggregate promotion is justified. Two-of-six source scope and semantic evidence remain incomplete/unknown.");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const generatedAt = new Date().toISOString();
  const loaded = loadArtifactManifest(WORKSPACE, SOURCE_ARTIFACT_SPECS, new Date(generatedAt));
  const artifacts = loaded.artifacts;
  const sourceArtifacts = Object.fromEntries(loaded.manifest.map((entry) => [entry.path, entry]));

  const step4Json = artifacts["reports/raw/fast/unit-static-implementation-upgrade.json"].json;
  const depthPath = "reports/raw/fast/hyperliquid-core-dex-depth-routes.json";
  const routeSummary = deriveUnitRouteSummary(artifacts[depthPath].json, sourceArtifacts[depthPath]);
  const implementationScope = implementationCoverage(TARGETS.map((row) => row.symbol));
  const checkpoint = buildIntegrityCheckpoint({
    manifest: loaded.manifest,
    routeSummary,
    coverage: implementationScope,
    mandatoryDomains: {
      economics: routeSummary.routeEvidenceStatus,
      sourceSemantics: "unknown",
      bytecodeSemantics: "unknown",
      storageLayout: "unknown",
      reserveBacking: "unknown",
    },
  });
  const operationalOutput = buildOperationalOutputSummary(routeSummary, []);
  const raw = {
    generatedAt,
    scanner: SCANNER,
    scope: "Unit / Hyperunit step-5 bounded source/build or bytecode-metadata semantic comparison; deterministic local artifacts and static recorded facts only",
    safety: {
      readOnlyResearch: true,
      deterministicLocalReduction: true,
      staticRecordedFactsOnly: true,
      externalHttpFetched: false,
      networkCalls: false,
      endpointInventoriesRead: false,
      envFilesRead: false,
      privateKeysRead: false,
      keyFilesRead: false,
      explorerApiKeysUsed: false,
      userApisCalled: false,
      generateAddressCalled: false,
      operationsAddressCalled: false,
      roleEthCalls: false,
      balanceCalls: false,
      supplyCalls: false,
      decimalsCalls: false,
      sourceChainQueries: false,
      transactionConstructed: false,
      transactionSimulated: false,
      signedActions: false,
      broadcasts: false,
      calldataExecuted: false,
      forkTransactions: false,
      walletOps: false,
      endpointEnumerationPerformed: false,
      exploitExecuteCalls: false,
      independentlyReproducedVerification: false,
      aggregateGatePromoted: false,
      routePositive: checkpoint.routePositiveOperational > 0,
      routePositiveOperational: checkpoint.routePositiveOperational,
      executableNow: false,
      signedActionJustified: false,
    },
    freshnessPolicy: FRESHNESS_POLICY,
    artifactManifest: loaded.manifest,
    staticSourceUrls: STATIC_SOURCE_URLS,
    sourceArtifacts,
    implementationCoverage: implementationScope,
    targetRows: buildTargetRows(),
    retrievalAvailabilityRows: buildRetrievalAvailabilityRows(),
    buildMetadataRows: buildMetadataRows(step4Json),
    bytecodeMetadataRows: buildBytecodeMetadataRows(),
    abiComparison: buildAbiComparison(step4Json),
    sourceSemanticMatrix: buildSourceSemanticMatrix(),
    storageLayoutComparison: buildStorageLayoutComparison(),
    sourcifyStatusRows: buildSourcifyStatusRows(),
    comparisonVerdict: {
      verdict: "abi-name-equivalent-only-source-bytecode-unavailable",
      authority: "recorded-public-abi-names-and-static-build-display-only",
      sourceEquality: "undetermined",
      runtimeBytecodeEquality: "undetermined",
      creationBytecodeEquality: "undetermined",
      storageLayoutEquality: "undetermined",
      metadataOnlyDifference: "undetermined",
      semanticEquality: "undetermined",
      vulnerabilityConclusion: "unknown",
      independentSemanticProof: false,
      semanticEvidenceStatus: "unknown",
      inputIndependence: "names-only-circular-recorded-context",
      conclusion: "UETH and USOL share recorded compiler/EVM/optimizer display and ABI method/event names, but source, bytecode, metadata, storage, and runtime equality cannot be determined.",
      routePositive: 0,
    },
    localEconomicsCarryForward: buildLocalEconomicsCarryForward(artifacts, routeSummary),
    routeSummary,
    operationalOutput,
    ...checkpoint,
    blockers: [
      "Full source text and standard-json build input were not retrieved, so source semantics and independent exact-match reproduction are unavailable.",
      "Runtime/creation bytecode, hashes, lengths, CBOR metadata trailer, IPFS/Swarm metadata, libraries, immutable references, and link references are unavailable.",
      "Sourcify returned HTTP 503 in reviewed research; this is temporary coverage loss, not evidence of no match.",
      "Recorded ABI comparison is names-only; canonical signatures, parameter/return types, indexed event fields, custom errors, and runtime behavior were not compared.",
      "Inheritance, storage layout, initializer, blacklist enforcement, decimals, HyperCore integration, upgrade authorization, issuance, and receive/fallback semantics remain unresolved.",
      "No source/runtime equivalence or semantic difference can be connected to permissionless reachability or economic extraction.",
      "Prior reserve/liability reconciliation remains unresolved; canonical economics status is derived separately without a hardcoded sign assumption.",
    ],
    requiredForRoutePositive: [
      "Authoritative full source/build input or independently reproducible verified source and compiler settings for both implementations.",
      "Deterministic runtime/creation bytecode and metadata comparison, including storage layout and upgrade compatibility, from separately authorized safe evidence.",
      "A concrete semantic difference or implementation flaw with permissionless reachability, not merely unavailable source or ABI-name parity.",
      "Current reserve/liability and wrapped-supply accounting effect attributable to the flaw.",
      "Exact positive consumer/DEX/lending economics and local positive-value proof before any route, fork, executor, or aggregate promotion.",
    ],
    nextReadOnlyStep: "If separately authorized and source availability improves, acquire authoritative standard-json/source bundles or deterministic bytecode metadata for UETH/USOL, reproduce builds, and compare storage/initializer/transfer/upgrade/issuance semantics without live role, balance, transaction, or gate actions.",
    routePositiveCandidates: operationalOutput.routePositiveCandidates,
    routePositiveOperational: checkpoint.routePositiveOperational,
    routeEvidenceStatus: checkpoint.routeEvidenceStatus,
    routePositive: checkpoint.routePositiveOperational,
    executableNow: 0,
    signedActionJustified: false,
  };

  writeAllowed(OUT_JSON, JSON.stringify(raw, null, 2) + "\n");
  writeAllowed(OUT_MD, renderReport(raw));

  console.log(`wrote ${rel(OUT_JSON)} and ${rel(OUT_MD)}`);
  console.log(`targets=${raw.targetRows.length} implementationCoverage=${raw.implementationCoverage.reviewedProxyCount}/6 semanticEvidence=unknown routeEvidenceStatus=${raw.routeEvidenceStatus} routePositiveOperational=${raw.routePositiveOperational} executableNow=0 signedActionJustified=false`);
}

main();
