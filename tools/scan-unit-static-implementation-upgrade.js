#!/usr/bin/env node
"use strict";

// Unit / Hyperunit step-4 bounded static implementation and upgrade-history verification.
// Deterministic local artifact reduction plus static recorded public explorer facts only.

const crypto = require("crypto");
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
const SCANNER = "tools/scan-unit-static-implementation-upgrade.js";
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "unit-static-implementation-upgrade.json");
const OUT_MD = path.join(WORKSPACE, "reports", "unit-static-implementation-upgrade-triage.md");

const ALLOWED_WRITES = new Set([
  "reports/raw/fast/unit-static-implementation-upgrade.json",
  "reports/unit-static-implementation-upgrade-triage.md",
]);

const SOURCE_ARTIFACTS = [
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
    : ["generatedAt", artifactPath.endsWith("unit-readonly-discovery.json") ? "unitAssetRows" : (artifactPath.endsWith("unit-proof-custody-accounting.json") ? "custodyReconciliationRows" : "publicContractRows")],
  requiredTypes: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json") ? { rows: "array" } : {},
}));

const STATIC_SOURCE_URLS = {
  hyperEvmExplorer: "https://hyperevmscan.io/",
  unitDocsIndex: "https://docs.hyperunit.xyz/llms.txt",
  unitComponents: "https://docs.hyperunit.xyz/architecture/components.md",
  unitTokenMetadata: "https://docs.hyperunit.xyz/developers/key-addresses/mainnet/token-metadata.md",
};

const COMMON_METHODS = [
  "name", "symbol", "decimals", "totalSupply", "balanceOf", "allowance", "transfer", "transferFrom", "approve",
  "owner", "transferOwnership", "renounceOwnership",
  "complianceAuthority", "transferComplianceAuthority", "addToBlacklist", "removeFromBlacklist", "isBlacklisted",
  "upgradeToAndCall", "proxiableUUID", "UPGRADE_INTERFACE_VERSION", "hyperCoreDeployer", "initialize",
];

const COMMON_EVENTS = [
  "Transfer", "Approval", "OwnershipTransferred", "ComplianceAuthorityTransferred", "AddedToBlacklist",
  "RemovedFromBlacklist", "Initialized", "Upgraded",
];

const SNAPSHOT_FACTS = [
  {
    symbol: "UETH",
    name: "Unit Ethereum",
    proxyAddress: "0xBe6727B535545C67d5cAa73dEa54865B92CF7907",
    implementationAddress: "0xE60DD45EBa5655e31CA1E61BEad4f983B3C4A83B",
    implementationName: "UnitEthereum",
    implementationVerification: "exact-match-verified",
    implementationCompiler: "0.8.28+commit.7893614a",
    implementationOptimizer: { enabled: false, runsDisplayed: 200 },
    implementationEvmVersion: "Paris",
    implementationLicense: "-NA-",
    proxyType: "OpenZeppelin ERC1967Proxy",
    proxyVerification: "verified",
    proxySourceFile: "lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol",
    proxyCompiler: "0.8.24+commit.e11b9ed9",
    proxyOptimizer: { enabled: true, runs: 200 },
    proxyEvmVersion: "Cancun",
    constructorInitData: null,
    constructorInitDataStatus: "not-displayed",
  },
  {
    symbol: "USOL",
    name: "Unit Solana",
    proxyAddress: "0x068f321Fa8Fb9f0D135f290Ef6a3e2813e1c8A29",
    implementationAddress: "0xaB73C0Ab9E4b931769373bd0C6480c022119D74c",
    implementationName: "UnitSolana",
    implementationVerification: "exact-match-verified",
    implementationCompiler: "0.8.28+commit.7893614a",
    implementationOptimizer: { enabled: false, runsDisplayed: 200 },
    implementationEvmVersion: "Paris",
    implementationLicense: "-NA-",
    proxyType: "OpenZeppelin ERC1967Proxy",
    proxyVerification: "verified",
    proxySourceFile: "lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol",
    proxyCompiler: "0.8.24+commit.e11b9ed9",
    proxyOptimizer: { enabled: true, runs: 200 },
    proxyEvmVersion: "Cancun",
    constructorInitData: "0x8129fc1c",
    constructorInitDataStatus: "initialize-selector-no-arguments-recorded",
  },
];

const UPGRADE_FACTS = [
  {
    symbol: "UETH",
    proxyAddress: "0xBe6727B535545C67d5cAa73dEa54865B92CF7907",
    transactionHash: "0x25f1b7d63792fa645a3b86ceb0351e0e8abfaa3ec6017a5a4c93eea1af3a98bf",
    blockNumber: 1546814,
    timestamp: "2025-03-24T19:23:00Z",
    event: "Upgraded",
    newImplementation: "0xE60DD45EBa5655e31CA1E61BEad4f983B3C4A83B",
  },
  {
    symbol: "USOL",
    proxyAddress: "0x068f321Fa8Fb9f0D135f290Ef6a3e2813e1c8A29",
    transactionHash: "0x3b64b0bcf63b31e22ace839a8067e4a5f4705744c6dc9e68d3cc39e2cd345ab2",
    blockNumber: 4132417,
    timestamp: "2025-05-21T17:49:00Z",
    event: "Upgraded",
    newImplementation: "0xaB73C0Ab9E4b931769373bd0C6480c022119D74c",
  },
];

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function assertAllowedWrite(file) {
  const relative = rel(path.resolve(file));
  if (!ALLOWED_WRITES.has(relative)) throw new Error(`Refusing to write outside Unit step-4 ownership: ${relative}`);
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

function staticFingerprint(methods, events) {
  const recorded = { methods: normalizedList(methods), events: normalizedList(events) };
  return crypto.createHash("sha256").update(JSON.stringify(recorded)).digest("hex");
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
    info.summary = pick(summary, [
      "targetsScanned", "depthAvailable", "exactDexQuoteRows", "bestNetUsd", "bestExactNetUsd",
      "routePositive", "executableNow", "signedActionJustified",
    ]);
    if (relPath.endsWith("unit-implementation-reserve-discovery.json")) {
      info.summary = {
        publicContractRows: Array.isArray(json.publicContractRows) ? json.publicContractRows.length : null,
        controlSurfaceRows: Array.isArray(json.controlSurfaceRows) ? json.controlSurfaceRows.length : null,
        implementationRepository: json.officialSourceVisibility && json.officialSourceVisibility.officialImplementationRepository,
        balancesFetched: json.reserveLiabilityVisibility && json.reserveLiabilityVisibility.sourceChainBalancesFetched,
        routePositive: json.routePositive ?? 0,
      };
    }
    if (relPath.endsWith("unit-proof-custody-accounting.json")) {
      info.summary = {
        treasuryAddressRows: Array.isArray(json.treasuryAddressRows) ? json.treasuryAddressRows.length : null,
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

function buildImplementationSnapshots() {
  const fingerprint = staticFingerprint(COMMON_METHODS, COMMON_EVENTS);
  return SNAPSHOT_FACTS.map((row) => ({
    ...row,
    sourceBodyAvailable: false,
    sourceFingerprint: null,
    decompilationAuthoritative: false,
    recordedAbiMethods: normalizedList(COMMON_METHODS),
    recordedAbiEvents: normalizedList(COMMON_EVENTS),
    abiStaticSnapshotFingerprintSha256: fingerprint,
    fingerprintLabel: "static-recorded-abi-fingerprint-not-runtime-proof",
    staticObservationOnly: true,
    liveDeployedStateVerifiedThisStep: false,
    explicitMintBurnAbiMethods: [],
    mintBurnConclusion: "absent-from-recorded-abi-do-not-infer-no-issuance-control",
    receiveFallbackConclusion: "not-exposed-by-recorded-implementation-abi-unresolved-from-abi-alone",
    currentRoleValues: "unresolved-not-queried",
    routePositive: 0,
  }));
}

function buildAbiMethodMatrix() {
  const common = normalizedList(COMMON_METHODS);
  return {
    comparisonAuthority: "recorded-public-abi-only",
    inputIndependence: "names-only-circular-recorded-context",
    independentSemanticProof: false,
    semanticEvidenceStatus: "unknown",
    runtimeProof: false,
    commonMethods: common,
    onlyUeth: [],
    onlyUsol: [],
    explicitMintMethods: [],
    explicitBurnMethods: [],
    receiveExposed: false,
    fallbackExposed: false,
    receiveFallbackCaveat: "No receive/fallback is exposed by the recorded implementation ABI; behavior remains unresolved from ABI alone.",
    normalizedStaticFingerprintSha256: staticFingerprint(common, COMMON_EVENTS),
    fingerprintLabel: "static-recorded-abi-fingerprint-not-runtime-proof",
  };
}

function buildEventMatrix() {
  const common = normalizedList(COMMON_EVENTS);
  return {
    comparisonAuthority: "recorded-public-abi-only",
    inputIndependence: "names-only-circular-recorded-context",
    independentSemanticProof: false,
    semanticEvidenceStatus: "unknown",
    commonEvents: common,
    onlyUeth: [],
    onlyUsol: [],
    normalizedStaticFingerprintSha256: staticFingerprint(COMMON_METHODS, common),
    fingerprintLabel: "static-recorded-abi-fingerprint-not-runtime-proof",
    eventPresenceDoesNotProveHistoricalCompleteness: true,
  };
}

function buildInitializationRows() {
  return [
    {
      symbol: "UETH",
      proxyAddress: SNAPSHOT_FACTS[0].proxyAddress,
      constructorInitData: null,
      selector: null,
      classification: "constructor-init-data-not-displayed",
      initializerBodyResolved: false,
      initializerArgumentsResolved: false,
      initialRoleValuesResolved: false,
      conclusion: "No initialization calldata or role values established from the recorded static explorer facts.",
      routePositive: 0,
    },
    {
      symbol: "USOL",
      proxyAddress: SNAPSHOT_FACTS[1].proxyAddress,
      constructorInitData: "0x8129fc1c",
      selector: "initialize()",
      classification: "initialize-selector-recorded-no-arguments",
      initializerBodyResolved: false,
      initializerArgumentsResolved: true,
      initialRoleValuesResolved: false,
      conclusion: "Recorded proxy init calldata supports initialize() with no encoded arguments; initializer body and resulting roles remain unresolved.",
      routePositive: 0,
    },
  ];
}

function buildUpgradeHistoryRows() {
  return UPGRADE_FACTS.map((row) => ({
    ...row,
    newImplementationMatchesRecordedCurrent: true,
    previousImplementation: "unresolved",
    upgradeCaller: "unresolved-not-queried",
    upgradeAuthorization: "unresolved-from-abi-without-source-body",
    historyCompleteness: "incomplete-single-explorer-recorded-event",
    eventContextCaveat: "Displayed event may be initialization/deployment-associated; one event does not establish complete governance upgrade history or a prior implementation.",
    staticObservationOnly: true,
    routePositive: 0,
  }));
}

function buildControlSurfaceClassification() {
  return [
    {
      surface: "UUPS/upgradeability",
      abiEvidence: ["upgradeToAndCall", "proxiableUUID", "UPGRADE_INTERFACE_VERSION", "Upgraded"],
      classification: "privileged-design-surface",
      authoritySemantics: "exact-_authorizeUpgrade-gate-unresolved",
      currentAuthority: "unresolved-not-queried",
      permissionlessReachability: "not-proven",
      economicProof: "none",
      routePositive: 0,
    },
    {
      surface: "owner controls",
      abiEvidence: ["owner", "transferOwnership", "renounceOwnership", "OwnershipTransferred"],
      classification: "privileged-design-surface",
      authoritySemantics: "function-bodies-and-modifiers-unresolved",
      currentAuthority: "unresolved-not-queried",
      permissionlessReachability: "not-proven",
      economicProof: "none",
      routePositive: 0,
    },
    {
      surface: "compliance/blacklist controls",
      abiEvidence: ["complianceAuthority", "transferComplianceAuthority", "addToBlacklist", "removeFromBlacklist", "isBlacklisted"],
      classification: "privileged-design-surface",
      authoritySemantics: "blacklist-enforcement-in-transfer-update-path-unresolved",
      currentAuthority: "unresolved-not-queried",
      permissionlessReachability: "not-proven",
      economicProof: "none",
      routePositive: 0,
    },
    {
      surface: "HyperCore integration",
      abiEvidence: ["hyperCoreDeployer"],
      classification: "integration-design-surface",
      authoritySemantics: "getter-semantics-and-issuance-relationship-unresolved",
      currentAuthority: "unresolved-not-queried",
      permissionlessReachability: "not-proven",
      economicProof: "none",
      routePositive: 0,
    },
    {
      surface: "ERC20 public methods",
      abiEvidence: ["transfer", "transferFrom", "approve", "balanceOf", "allowance", "totalSupply"],
      classification: "permissionless-standard-surface",
      authoritySemantics: "implementation-function-bodies-unavailable",
      currentAuthority: "not-applicable",
      permissionlessReachability: "standard-methods-recorded-abi-only",
      economicProof: "no-positive-route-prior-depth-negative",
      routePositive: 0,
    },
  ];
}

function buildLocalEconomicsCarryForward(artifacts, routeSummary) {
  const step1 = artifacts["reports/raw/fast/unit-readonly-discovery.json"].json;
  const step3 = artifacts["reports/raw/fast/unit-implementation-reserve-discovery.json"].json;
  const depth = artifacts["reports/raw/fast/hyperliquid-core-dex-depth-routes.json"].json;
  const unitRows = Array.isArray(step1 && step1.unitAssetRows) ? step1.unitAssetRows : [];
  const depthSummary = depth && depth.summary ? depth.summary : {};
  return {
    systemBalanceExceedsSupply: step1 && step1.sourceArtifacts && step1.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"] && step1.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].summary && step1.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].summary.systemBalanceExceedsSupply,
    consumerJoins: step1 && step1.consumerJoinSummary && step1.consumerJoinSummary.hyperliquidLinkedTokenConsumers && step1.consumerJoinSummary.hyperliquidLinkedTokenConsumers.consumerJoins,
    hyperlendJoins: step1 && step1.consumerJoinSummary && step1.consumerJoinSummary.hyperliquidLinkedTokenConsumers && step1.consumerJoinSummary.hyperliquidLinkedTokenConsumers.hyperlendJoins,
    globalDepthSourceTargetsScannedNotUnitSummary: depthSummary.targetsScanned ?? null,
    bestExactNetUsd: routeSummary.bestExactUnitRoute?.netUsd ?? null,
    bestEstimatedNetUsd: routeSummary.bestEstimatedUnitRoute?.netUsd ?? null,
    reserveLiabilityReconciliationStatus: step3 && step3.reserveLiabilityVisibility && step3.reserveLiabilityVisibility.reconciliationStatus,
    keyAssetEconomics: unitRows
      .filter((row) => ["UBTC", "UETH", "USOL"].includes(String(row.symbol || "").toUpperCase()))
      .map((row) => ({
        symbol: row.symbol,
        maxDexLiquidityUsd: row.summarizedMetrics && row.summarizedMetrics.maxDexLiquidityUsd,
        maxBorrowCashUsd: row.summarizedMetrics && row.summarizedMetrics.maxBorrowCashUsd,
        bestExactNetUsd: row.summarizedMetrics && row.summarizedMetrics.bestExactNetUsd,
        routePositive: row.summarizedMetrics && row.summarizedMetrics.routePositive ? 1 : 0,
      })),
    canonicalUnitRouteSummary: routeSummary,
    conclusion: "Names-only/circular ABI observations do not change stale economics or unresolved reserve/liability reconciliation.",
    routePositive: routeSummary.routePositiveOperational,
    executableNow: 0,
    signedActionJustified: false,
  };
}

function renderReport(raw) {
  const lines = [];
  lines.push("# Unit / Hyperunit Static Implementation and Upgrade Verification");
  lines.push("");
  lines.push(`Signal: ${raw.operationalOutput.signalLabel} — auditClassification=${raw.auditClassification}, routeEvidenceStatus=${raw.routeEvidenceStatus}, routePositiveOperational=${raw.routePositiveOperational}, executableNow=0, signedActionJustified=false.`);
  lines.push("");
  lines.push("## Scope / Safety");
  lines.push("");
  lines.push(`- Scanner: \`${raw.scanner}\`, generated \`${raw.generatedAt}\`.`);
  lines.push("- Step 4 is deterministic local reduction plus static recorded public verified-source/explorer facts only; no network or live deployed-state calls were made.");
  lines.push("- Observations are static recorded snapshots, not runtime proof. Source bodies were unavailable in reviewed output, and decompilation is not treated as authoritative source.");
  lines.push("- No endpoints, env/key material, user APIs, roles, balances, supplies, chain queries, calldata, transactions, forks, wallets, exploit execution, or aggregate gate promotion.");
  lines.push(`- Implementation scope=${raw.implementationCoverage.reviewedProxyCount}/${raw.implementationCoverage.observedProxyCount}; missing=${raw.implementationCoverage.missingProxySymbols.join(", ")}; evidence complete=${raw.evidenceComplete}.`);
  lines.push("");
  lines.push("## Implementation Snapshot");
  lines.push("");
  lines.push("| Token | Proxy | Proxy compiler | Implementation | Verification | Impl compiler | Source body | Fingerprint label |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const row of raw.implementationSnapshots) {
    lines.push(`| ${md(row.symbol)} | ${md(row.proxyAddress)} | ${md(row.proxyCompiler)} | ${md(row.implementationAddress)} | ${md(row.implementationVerification)} | ${md(row.implementationCompiler)} | ${row.sourceBodyAvailable} | ${md(row.fingerprintLabel)} |`);
  }
  lines.push("");
  lines.push("Both recorded implementation ABIs have deterministic identical static fingerprints, but this is names-only/circular recorded context, not independent equivalence, runtime, or source-body proof; semantic evidence remains unknown.");
  lines.push("");
  lines.push("## ABI Method / Event Comparison");
  lines.push("");
  lines.push(`- Comparison authority: \`${raw.abiMethodMatrix.comparisonAuthority}\`.`);
  lines.push(`- Common methods (${raw.abiMethodMatrix.commonMethods.length}): ${raw.abiMethodMatrix.commonMethods.join(", ")}.`);
  lines.push(`- Common events (${raw.eventMatrix.commonEvents.length}): ${raw.eventMatrix.commonEvents.join(", ")}.`);
  lines.push("- Only-UETH methods/events: none; only-USOL methods/events: none, based solely on recorded public ABI facts.");
  lines.push("- Explicit mint/burn methods: absent from recorded ABI; do not infer no issuance control. Receive/fallback behavior remains unresolved from ABI alone.");
  lines.push("");
  lines.push("## Initialization Evidence");
  lines.push("");
  lines.push("| Token | Constructor init data | Selector | Classification | Roles resolved | Conclusion |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of raw.initializationRows) {
    lines.push(`| ${md(row.symbol)} | ${md(row.constructorInitData || "not displayed")} | ${md(row.selector || "unresolved")} | ${md(row.classification)} | ${row.initialRoleValuesResolved} | ${md(row.conclusion)} |`);
  }
  lines.push("");
  lines.push("## Upgrade History");
  lines.push("");
  lines.push("| Token | Block / time | Transaction | New implementation | Previous | Completeness |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of raw.upgradeHistoryRows) {
    lines.push(`| ${md(row.symbol)} | ${row.blockNumber} / ${md(row.timestamp)} | ${md(row.transactionHash)} | ${md(row.newImplementation)} | ${md(row.previousImplementation)} | ${md(row.historyCompleteness)} |`);
  }
  lines.push("");
  lines.push("Each event may be initialization/deployment-associated. A single displayed event does not establish complete governance upgrade history or a prior implementation.");
  lines.push("");
  lines.push("## Privileged Control Classification");
  lines.push("");
  lines.push("| Surface | Classification | Authority semantics | Permissionless reachability | Economic proof |");
  lines.push("|---|---|---|---|---|");
  for (const row of raw.controlSurfaceClassification) {
    lines.push(`| ${md(row.surface)} | ${md(row.classification)} | ${md(row.authoritySemantics)} | ${md(row.permissionlessReachability)} | ${md(row.economicProof)} |`);
  }
  lines.push("");
  lines.push("Privileged/design surfaces are not permissionless bypasses. No live role holder, permissionless reachability, or positive economic proof was established.");
  lines.push("");
  lines.push("## Unresolved Source Semantics");
  lines.push("");
  for (const item of raw.unresolvedSourceSemantics) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## Local Economics Carry-Forward");
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
  for (const item of raw.requiredForRoutePositive) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("");
  lines.push(`- ${raw.nextReadOnlyStep}`);
  lines.push("");
  lines.push("## Gate Status");
  lines.push("");
  lines.push("No route, executor, fork, transaction, signed action, route sweep, completion gate, or aggregate promotion is justified. Two-of-six implementation scope and names-only semantics remain incomplete/unknown.");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const generatedAt = new Date().toISOString();
  const loaded = loadArtifactManifest(WORKSPACE, SOURCE_ARTIFACT_SPECS, new Date(generatedAt));
  const artifacts = loaded.artifacts;
  const sourceArtifacts = Object.fromEntries(loaded.manifest.map((entry) => [entry.path, entry]));
  const depthPath = "reports/raw/fast/hyperliquid-core-dex-depth-routes.json";
  const routeSummary = deriveUnitRouteSummary(artifacts[depthPath].json, sourceArtifacts[depthPath]);
  const implementationScope = implementationCoverage(SNAPSHOT_FACTS.map((row) => row.symbol));
  const checkpoint = buildIntegrityCheckpoint({
    manifest: loaded.manifest,
    routeSummary,
    coverage: implementationScope,
    mandatoryDomains: {
      economics: routeSummary.routeEvidenceStatus,
      implementationSemantics: "unknown",
      upgradeHistory: "unknown",
      reserveBacking: "unknown",
    },
  });
  const operationalOutput = buildOperationalOutputSummary(routeSummary, []);

  const raw = {
    generatedAt,
    scanner: SCANNER,
    scope: "Unit / Hyperunit step-4 bounded static implementation and upgrade-history verification; static recorded facts and local artifact reduction only",
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
      userApisCalled: false,
      generateAddressCalled: false,
      operationsAddressCalled: false,
      roleEthCalls: false,
      balanceCalls: false,
      supplyCalls: false,
      sourceChainQueries: false,
      endpointEnumerationPerformed: false,
      transactions: false,
      signedActions: false,
      broadcasts: false,
      calldataExecuted: false,
      forkTransactions: false,
      walletOps: false,
      exploitExecuteCalls: false,
      decompilationAuthoritative: false,
      liveDeployedStateVerified: false,
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
    implementationSnapshots: buildImplementationSnapshots(),
    abiMethodMatrix: buildAbiMethodMatrix(),
    eventMatrix: buildEventMatrix(),
    staticSemanticComparison: {
      comparisonAuthority: "recorded-public-abi-only",
      commonMethodCount: normalizedList(COMMON_METHODS).length,
      commonEventCount: normalizedList(COMMON_EVENTS).length,
      onlyUethMethods: [],
      onlyUsolMethods: [],
      onlyUethEvents: [],
      onlyUsolEvents: [],
      sourceBodiesCompared: false,
      bytecodeCompared: false,
      storageLayoutsCompared: false,
      runtimeBehaviorCompared: false,
      inputIndependence: "names-only-circular-recorded-context",
      independentSemanticProof: false,
      semanticEvidenceStatus: "unknown",
      conclusion: "Recorded public ABI method/event sets match; semantic equivalence is not established without source bodies, bytecode, storage layout, or runtime verification.",
      routePositive: 0,
    },
    initializationRows: buildInitializationRows(),
    upgradeHistoryRows: buildUpgradeHistoryRows(),
    controlSurfaceClassification: buildControlSurfaceClassification(),
    unresolvedSourceSemantics: [
      "Full implementation source text and function bodies were not retrievable in reviewed public explorer output despite exact-match verified status.",
      "Exact inheritance clauses, source/import graph, and storage layout remain unresolved.",
      "Initializer body and constructor _disableInitializers behavior remain unresolved.",
      "The decimals return value remains unresolved from the recorded method name alone.",
      "Blacklist enforcement in transfer/update paths remains unresolved; ABI presence does not prove enforcement semantics.",
      "hyperCoreDeployer getter semantics and its relationship to issuance remain unresolved.",
      "Exact _authorizeUpgrade gate remains unresolved; do not claim onlyOwner authorization from ABI surface.",
      "Fallback/receive behavior remains unresolved from ABI alone.",
      "Explicit mint/burn ABI methods are absent, but issuance authority and mint/burn mechanics must not be inferred absent.",
      "Current owner, compliance authority, HyperCore deployer, proxy admin, minter, and burner values were not queried.",
      "A single explorer-recorded Upgraded event is incomplete history and may be initialization/deployment-associated.",
    ],
    localEconomicsCarryForward: buildLocalEconomicsCarryForward(artifacts, routeSummary),
    routeSummary,
    operationalOutput,
    ...checkpoint,
    blockers: [
      "Source bodies, import graph, inheritance, storage layout, initializer logic, and upgrade authorization function body were not available in the reviewed static output.",
      "Recorded ABI parity does not prove source, bytecode, storage, or runtime semantic equivalence.",
      "Current privileged role values and permissionless reachability remain unresolved-not-queried.",
      "Upgrade history is incomplete-single-explorer-recorded-event for each proxy; previous implementation and complete governance history are unresolved.",
      "No public mint/burn ABI methods were recorded, but no conclusion about issuance control can be drawn from ABI absence.",
      "Reserve/liability reconciliation remains unknown; canonical economics status is derived separately without a hardcoded sign assumption.",
      "No permissionless static implementation or upgrade bypass with economic proof is established.",
    ],
    requiredForRoutePositive: [
      "Authoritative full implementation source or separately authorized deterministic bytecode/source verification establishing actual initializer, storage, transfer, compliance, HyperCore, and upgrade semantics.",
      "Complete proxy deployment and upgrade history with previous implementations and authorization transitions established from safe read-only evidence.",
      "A concrete permissionless path through implementation or upgrade logic, distinct from privileged owner/compliance/design controls.",
      "Current reserve/liability and wrapped-supply reconciliation showing an exploitable accounting effect.",
      "Exact positive consumer/DEX/lending economics and local positive-value proof before any route, fork, executor, or aggregate promotion.",
    ],
    nextReadOnlyStep: "If separately authorized, obtain authoritative full verified source text/build metadata or deterministic bytecode metadata for UETH/USOL and compare initializer, storage, transfer/compliance, HyperCore, and _authorizeUpgrade semantics without role calls, balances, transactions, or gate changes.",
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
  console.log(`snapshots=${raw.implementationSnapshots.length} implementationCoverage=${raw.implementationCoverage.reviewedProxyCount}/6 semanticEvidence=unknown routeEvidenceStatus=${raw.routeEvidenceStatus} routePositiveOperational=${raw.routePositiveOperational} executableNow=0 signedActionJustified=false`);
}

main();
