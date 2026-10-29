#!/usr/bin/env node
"use strict";

// Unit / Hyperunit step-3 implementation/source and reserve/liability discovery.
// Deterministic local reduction plus static public research facts only; no network calls.

const fs = require("fs");
const path = require("path");
const {
  FRESHNESS_POLICY,
  buildIntegrityCheckpoint,
  buildOperationalOutputSummary,
  deriveUnitRouteSummary,
  implementationCoverage,
  loadArtifactManifest,
  validateObservedProxyCoverage,
} = require("./lib/unit-audit-integrity");

const WORKSPACE = path.resolve(__dirname, "..");
const SCANNER = "tools/scan-unit-implementation-reserve-discovery.js";
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "unit-implementation-reserve-discovery.json");
const OUT_MD = path.join(WORKSPACE, "reports", "unit-implementation-reserve-discovery-triage.md");

const ALLOWED_WRITES = new Set([
  "reports/raw/fast/unit-implementation-reserve-discovery.json",
  "reports/unit-implementation-reserve-discovery-triage.md",
]);

const SOURCE_ARTIFACTS = [
  "reports/raw/fast/unit-readonly-discovery.json",
  "reports/raw/fast/unit-proof-custody-accounting.json",
  "reports/raw/fast/hyperliquid-linked-token-invariants.json",
  "reports/raw/fast/hyperliquid-linked-token-consumers.json",
  "reports/raw/fast/hyperliquid-core-dex-depth-routes.json",
];

const SOURCE_ARTIFACT_SPECS = SOURCE_ARTIFACTS.map((artifactPath) => ({
  path: artifactPath,
  required: true,
  evidenceClass: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json") ? "marketEconomics"
    : (artifactPath.includes("/unit-") ? "derived" : "dynamicSnapshot"),
  requiredPaths: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json")
    ? ["generatedAt", "rows"]
    : ["generatedAt", artifactPath.endsWith("unit-readonly-discovery.json") ? "unitAssetRows" : (artifactPath.endsWith("unit-proof-custody-accounting.json") ? "custodyReconciliationRows" : "summary")],
  requiredTypes: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json") ? { rows: "array" } : {},
}));

const STATIC_SOURCE_URLS = {
  docsIndex: "https://docs.hyperunit.xyz/llms.txt",
  components: "https://docs.hyperunit.xyz/architecture/components.md",
  depositLifecycle: "https://docs.hyperunit.xyz/developers/api/operations/deposit-lifecycle.md",
  mainnetKeyAddresses: "https://docs.hyperunit.xyz/developers/key-addresses/mainnet.md",
  mainnetTokenMetadata: "https://docs.hyperunit.xyz/developers/key-addresses/mainnet/token-metadata.md",
  apiOverview: "https://docs.hyperunit.xyz/developers/api.md",
  estimateFees: "https://docs.hyperunit.xyz/developers/api/estimate-fees.md",
  withdrawalQueue: "https://docs.hyperunit.xyz/developers/api/withdraw-queue.md",
  operations: "https://docs.hyperunit.xyz/developers/api/operations.md",
  supportedAssets: "https://docs.hyperunit.xyz/unit/about-unit/supported-assets.md",
  hyperEvmExplorer: "https://hyperevmscan.io/",
};

const UNIT_DEPLOYER = "0xb4fc973924a91362d301e583e839cdaf4f19cdf8";

const PUBLIC_CONTRACT_ROWS = [
  {
    symbol: "UBTC",
    name: "Unit Bitcoin",
    proxyAddress: "0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463",
    proxyType: "ERC1967Proxy",
    proxySourceVerification: "verified-exact-match",
    implementationAddress: "0x1a7689c3B783EB37550efBB9c81e7F468F7034FC",
    implementationName: null,
    implementationSourceVerification: "unverified",
    deployer: UNIT_DEPLOYER,
    deployerLabel: "Unit: Deployer",
    currentUpgradeBlock: 1513232,
    currentUpgradeDate: null,
    verifiedAbiStatus: "implementation-unverified-no-authoritative-abi",
    mintBurnAbiStatus: "unresolved-no-public-verified-implementation-abi",
    currentRoleValues: "unresolved-not-queried",
    source: "public-explorer-static-metadata",
    routePositive: 0,
  },
  {
    symbol: "UETH",
    name: "Unit Ethereum",
    proxyAddress: "0xBe6727B535545C67d5cAa73dEa54865B92CF7907",
    proxyType: "ERC1967Proxy",
    proxySourceVerification: "verified-exact-match",
    implementationAddress: "0xE60DD45EBa5655e31CA1E61BEad4f983B3C4A83B",
    implementationName: "UnitEthereum",
    implementationSourceVerification: "verified-exact-match",
    deployer: UNIT_DEPLOYER,
    deployerLabel: "Unit: Deployer",
    currentUpgradeBlock: 1546814,
    currentUpgradeDate: "2025-03-24",
    verifiedAbiStatus: "verified-control-surface-available",
    mintBurnAbiStatus: "no-public-mint-burn-methods-found-do-not-infer-no-issuance-control",
    currentRoleValues: "unresolved-not-queried",
    source: "public-explorer-static-metadata",
    routePositive: 0,
  },
  {
    symbol: "USOL",
    name: "Unit Solana",
    proxyAddress: "0x068f321Fa8Fb9f0D135f290Ef6a3e2813e1c8A29",
    proxyType: "ERC1967Proxy",
    proxySourceVerification: "verified-exact-match",
    implementationAddress: "0xaB73C0Ab9E4b931769373bd0C6480c022119D74c",
    implementationName: "UnitSolana",
    implementationSourceVerification: "verified-exact-match",
    deployer: UNIT_DEPLOYER,
    deployerLabel: "Unit: Deployer",
    currentUpgradeBlock: 4132417,
    currentUpgradeDate: "2025-05-21",
    verifiedAbiStatus: "verified-control-surface-available",
    mintBurnAbiStatus: "no-public-mint-burn-methods-found-do-not-infer-no-issuance-control",
    currentRoleValues: "unresolved-not-queried",
    source: "public-explorer-static-metadata",
    routePositive: 0,
  },
  {
    symbol: "UFART", name: "Unit Fartcoin", proxyAddress: "0x3B4575E689DEd21CAAD31d64C4df1f10F3B2CedF",
    proxyType: "observed-proxy-like", proxySourceVerification: "local-linked-token-observation", implementationAddress: null,
    implementationName: null, implementationSourceVerification: "not-reviewed", deployer: null, deployerLabel: null,
    currentUpgradeBlock: null, currentUpgradeDate: null, verifiedAbiStatus: "not-reviewed", mintBurnAbiStatus: "unresolved",
    currentRoleValues: "unresolved-not-queried", source: "local-canonical-registry", routePositive: 0,
  },
  {
    symbol: "UPUMP", name: "Unit Pump", proxyAddress: "0x27eC642013bcb3d80ca3706599d3cdA04F6f4452",
    proxyType: "observed-proxy-like", proxySourceVerification: "local-linked-token-observation", implementationAddress: null,
    implementationName: null, implementationSourceVerification: "not-reviewed", deployer: null, deployerLabel: null,
    currentUpgradeBlock: null, currentUpgradeDate: null, verifiedAbiStatus: "not-reviewed", mintBurnAbiStatus: "unresolved",
    currentRoleValues: "unresolved-not-queried", source: "local-canonical-registry", routePositive: 0,
  },
  {
    symbol: "UXPL", name: "Unit Plasma", proxyAddress: "0x33af3c2540ba72054e044efe504867b39ae421f5",
    proxyType: "observed-proxy-like", proxySourceVerification: "local-linked-token-observation", implementationAddress: null,
    implementationName: null, implementationSourceVerification: "not-reviewed", deployer: null, deployerLabel: null,
    currentUpgradeBlock: null, currentUpgradeDate: null, verifiedAbiStatus: "not-reviewed", mintBurnAbiStatus: "unresolved",
    currentRoleValues: "unresolved-not-queried", source: "local-canonical-registry", routePositive: 0,
  },
];

const CONTROL_METHODS = [
  "owner",
  "transferOwnership",
  "renounceOwnership",
  "complianceAuthority",
  "transferComplianceAuthority",
  "addToBlacklist",
  "removeFromBlacklist",
  "isBlacklisted",
  "upgradeToAndCall",
  "proxiableUUID",
  "hyperCoreDeployer",
];

const ENDPOINT_CANDIDATE_ROWS = [
  {
    method: "GET",
    endpoint: "https://api.hyperunit.xyz/v2/estimate-fees",
    purpose: "aggregate fee and ETA configuration",
    classification: "safe-aggregate-candidate-not-fetched",
    called: false,
    reserveLiabilityUse: "none-direct",
  },
  {
    method: "GET",
    endpoint: "https://api.hyperunit.xyz/withdrawal-queue",
    purpose: "aggregate BTC/ETH withdrawal queue length and last batch operation transaction ID",
    classification: "safe-aggregate-candidate-not-fetched",
    called: false,
    reserveLiabilityUse: "operational-context-not-proof-of-reserves",
  },
  {
    method: "GET",
    endpoint: "/operations/:address",
    purpose: "address-scoped operation history",
    classification: "gated-not-called",
    called: false,
    reserveLiabilityUse: "not-an-aggregate-liability-endpoint",
  },
  {
    method: "GET",
    endpoint: "/gen/:src_chain/:dst_chain/:asset/:dst_addr",
    purpose: "generate user-specific deposit address",
    classification: "denied-not-called",
    called: false,
    reserveLiabilityUse: "none",
  },
  {
    method: null,
    endpoint: "Hyperunit explorer aggregate reserve API/schema",
    purpose: "possible reserve, treasury, supply, or liability aggregation",
    classification: "unresolved-not-enumerated",
    called: false,
    reserveLiabilityUse: "no-documented-schema-resolved",
  },
];

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function assertAllowedWrite(file) {
  const relative = rel(path.resolve(file));
  if (!ALLOWED_WRITES.has(relative)) throw new Error(`Refusing to write outside Unit step-3 ownership: ${relative}`);
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
      "hyperCoreTokens", "linkedTokensScanned", "systemBalanceExceedsSupply", "watchCandidates", "reviewCandidates",
      "joinedRows", "consumerJoins", "hyperlendJoins", "yieldJoins", "dexJoins", "researchPositiveRows",
      "targetsScanned", "depthAvailable", "exactDexQuoteRows", "multiHopExactRows", "bestNetUsd", "bestExactNetUsd",
      "routePositive", "executableNow", "signedActionJustified",
    ]);
    if (relPath.endsWith("unit-readonly-discovery.json")) {
      info.summary = {
        unitAssetRows: Array.isArray(json.unitAssetRows) ? json.unitAssetRows.length : null,
        systemBalanceExceedsSupply: json.sourceArtifacts && json.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"] && json.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].summary && json.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].summary.systemBalanceExceedsSupply,
        consumerJoins: json.consumerJoinSummary && json.consumerJoinSummary.hyperliquidLinkedTokenConsumers && json.consumerJoinSummary.hyperliquidLinkedTokenConsumers.consumerJoins,
        bestExactNetUsd: json.economicsSummary && json.economicsSummary.bestExactNetUsd,
        routePositive: json.routePositive ?? 0,
      };
    }
    if (relPath.endsWith("unit-proof-custody-accounting.json")) {
      info.summary = {
        treasuryAddressRows: Array.isArray(json.treasuryAddressRows) ? json.treasuryAddressRows.length : null,
        tokenMetadataRows: Array.isArray(json.tokenMetadataRows) ? json.tokenMetadataRows.length : null,
        custodyReconciliationRows: Array.isArray(json.custodyReconciliationRows) ? json.custodyReconciliationRows.length : null,
        metadataDiscrepancies: Array.isArray(json.metadataDiscrepancies) ? json.metadataDiscrepancies.length : null,
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

function buildControlSurfaceRows() {
  return PUBLIC_CONTRACT_ROWS.map((contract) => ({
    symbol: contract.symbol,
    proxyAddress: contract.proxyAddress,
    implementationAddress: contract.implementationAddress,
    implementationSourceVerification: contract.implementationSourceVerification,
    verifiedAbiMethods: contract.implementationSourceVerification === "verified-exact-match" ? CONTROL_METHODS : [],
    owner: "unresolved-not-queried",
    complianceAuthority: "unresolved-not-queried",
    hyperCoreDeployer: "unresolved-not-queried",
    proxyAdmin: "unresolved-not-queried",
    minter: "unresolved-not-queried",
    burner: "unresolved-not-queried",
    issuanceAuthorityConclusion: "not-inferred-from-abi-absence",
    routePositive: 0,
  }));
}

function buildReserveLiabilityVisibility(step2Json) {
  const treasuryRows = Array.isArray(step2Json && step2Json.treasuryAddressRows) ? step2Json.treasuryAddressRows : [];
  const custodyRows = Array.isArray(step2Json && step2Json.custodyReconciliationRows) ? step2Json.custodyReconciliationRows : [];
  return {
    treasuryAddressesKnown: treasuryRows.length > 0,
    treasuryAddressRowsCarriedForward: treasuryRows.length,
    tokenCustodyRowsCarriedForward: custodyRows.length,
    sourceChainBalancesFetched: false,
    hyperCoreTreasuryBalancesFetched: false,
    wrappedTokenSupplyFetchedThisStep: false,
    perAssetLiabilitiesFetched: false,
    officialProofOfReservesFound: false,
    officialReserveAttestationFound: false,
    officialPerAssetLiabilityEndpointFound: false,
    officialReconciliationEndpointOrDashboardFound: false,
    explorerAggregateReserveSchemaResolved: false,
    explorerEndpointEnumerationPerformed: false,
    balanceStatus: "addresses-known-balances-not-fetched",
    liabilityStatus: "per-asset-liabilities-not-found-or-fetched",
    reconciliationStatus: "not-performed-no-authoritative-balance-liability-join",
    deficitSurplusConclusion: "none-cannot-conclude-deficit-or-surplus",
    caveat: "No endpoint found is not proof that no endpoint exists; current reviewed public docs/explorer metadata did not establish one.",
    routePositive: 0,
  };
}

function buildLocalCarryForward(artifacts, routeSummary) {
  const step1 = artifacts["reports/raw/fast/unit-readonly-discovery.json"].json;
  const step2 = artifacts["reports/raw/fast/unit-proof-custody-accounting.json"].json;
  const invariant = artifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].info.summary || {};
  const consumer = artifacts["reports/raw/fast/hyperliquid-linked-token-consumers.json"].info.summary || {};
  const depth = artifacts["reports/raw/fast/hyperliquid-core-dex-depth-routes.json"].info.summary?.globalSourceContextNotUnitSummary || {};
  const unitRows = Array.isArray(step1 && step1.unitAssetRows) ? step1.unitAssetRows : [];
  return {
    unitAssets: unitRows.length,
    implementationEvidenceBeforeStep3: "no-verified-source-abi-bytecode-decompile-proxy-implementation-role-evidence-beyond-documentation-derived-artifacts",
    absenceInferenceProhibited: true,
    linkedTokensScanned: invariant.linkedTokensScanned ?? null,
    systemBalanceExceedsSupply: invariant.systemBalanceExceedsSupply ?? null,
    consumerJoins: consumer.consumerJoins ?? null,
    hyperlendJoins: consumer.hyperlendJoins ?? null,
    globalDepthSourceTargetsScannedNotUnitSummary: depth.targetsScanned ?? null,
    bestExactNetUsd: routeSummary.bestExactUnitRoute?.netUsd ?? null,
    bestEstimatedNetUsd: routeSummary.bestEstimatedUnitRoute?.netUsd ?? null,
    treasuryAddressRows: Array.isArray(step2 && step2.treasuryAddressRows) ? step2.treasuryAddressRows.length : 0,
    custodyReconciliationRows: Array.isArray(step2 && step2.custodyReconciliationRows) ? step2.custodyReconciliationRows.length : 0,
    custodyLiabilityReconciled: false,
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
    conclusion: "Prior local ERC20 sanity and economics remain fail-closed; the sanity check is non-probative for backing and stale economics is unknown rather than clean-negative.",
    routePositive: routeSummary.routePositiveOperational,
    executableNow: 0,
    signedActionJustified: false,
  };
}

function renderReport(raw) {
  const lines = [];
  lines.push("# Unit / Hyperunit Implementation and Reserve/Liability Discovery");
  lines.push("");
  lines.push(`Signal: ${raw.operationalOutput.signalLabel} — auditClassification=${raw.auditClassification}, routeEvidenceStatus=${raw.routeEvidenceStatus}, routePositiveOperational=${raw.routePositiveOperational}, executableNow=0, signedActionJustified=false.`);
  lines.push("");
  lines.push("## Scope / Safety");
  lines.push("");
  lines.push(`- Scanner: \`${raw.scanner}\`, generated \`${raw.generatedAt}\`.`);
  lines.push("- Step 3 only: deterministic local artifact reduction plus static public implementation/explorer research facts; externalHttpFetched=false.");
  lines.push("- No endpoint inventories, env/key files, network calls, source-chain balances, role calls, endpoint enumeration, user-specific APIs, transactions, calldata, forks, wallets, or aggregate gate promotion.");
  lines.push(`- Evidence complete=${raw.evidenceComplete}; closure eligible=${raw.closureEligible}.`);
  lines.push("");
  lines.push("## Official Source Visibility");
  lines.push("");
  lines.push(`- Official implementation repository: ${raw.officialSourceVisibility.officialImplementationRepository}.`);
  lines.push(`- Official SDK/package reference: ${raw.officialSourceVisibility.officialSdkOrPackageReference}.`);
  lines.push("- Guardian Agent, Chain Services, Flow Manager, Consensus Service, and Wallet Manager are documented as components, but no public source repository/schema was established.");
  lines.push("- `unitxyz/unitxyz` exists publicly, but reviewed public context did not establish it as the bridge/agent/contracts implementation. This is not proof that source is absent.");
  lines.push("- No public mint/burn implementation reference was established; do not infer issuance authority from absent ABI methods.");
  lines.push("");
  lines.push("## HyperEVM Proxy / Implementation Table");
  lines.push("");
  lines.push("| Token | Proxy | Proxy verification | Implementation | Implementation verification | Upgrade | Current roles |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const row of raw.publicContractRows) {
    const upgrade = [row.currentUpgradeBlock != null ? `block ${row.currentUpgradeBlock}` : null, row.currentUpgradeDate].filter(Boolean).join(" / ");
    lines.push(`| ${md(row.symbol)} | ${md(row.proxyAddress)} | ${md(row.proxySourceVerification)} | ${md(row.implementationAddress)} | ${md(row.implementationSourceVerification)} | ${md(upgrade)} | ${md(row.currentRoleValues)} |`);
  }
  lines.push(`- Coverage: observed=${raw.implementationCoverage.observedProxyCount} (${raw.implementationCoverage.observedProxySymbols.join(", ")}); implementation metadata reviewed=${raw.implementationCoverage.reviewedProxyCount}; missing=${raw.implementationCoverage.missingProxySymbols.join(", ")}; status=${raw.implementationCoverage.status}.`);
  lines.push(`- Canonical registry/invariant proxy validation: ${raw.canonicalProxyCoverage.status}; mismatches=${raw.canonicalProxyCoverage.mismatchFlags.length}.`);
  lines.push(`- Verified-source subset: ${raw.verifiedSourceCoverage.reviewedProxyCount}/6; status=${raw.verifiedSourceCoverage.status}.`);
  lines.push("");
  lines.push("## Verified Control Surface");
  lines.push("");
  lines.push("| Token | Verified methods | Owner | Compliance authority | HyperCore deployer | Minter/burner |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of raw.controlSurfaceRows) {
    lines.push(`| ${md(row.symbol)} | ${md(row.verifiedAbiMethods.join(", ") || "none from verified implementation")} | ${md(row.owner)} | ${md(row.complianceAuthority)} | ${md(row.hyperCoreDeployer)} | ${md(`${row.minter} / ${row.burner}`)} |`);
  }
  lines.push("");
  lines.push("The UETH/USOL verified ABI exposes ownership, compliance/blacklist, upgrade, proxiable UUID, and HyperCore deployer surfaces. No public mint/burn methods were found, but no conclusion about issuance control is inferred.");
  lines.push("");
  lines.push("## Public Endpoint Classification");
  lines.push("");
  lines.push("| Method | Endpoint | Purpose | Classification | Called |");
  lines.push("|---|---|---|---|---|");
  for (const row of raw.endpointCandidateRows) {
    lines.push(`| ${md(row.method || "n/a")} | ${md(row.endpoint)} | ${md(row.purpose)} | ${md(row.classification)} | ${row.called} |`);
  }
  lines.push("");
  lines.push("## Reserve / Liability Visibility");
  lines.push("");
  lines.push(`- Treasury addresses known=${raw.reserveLiabilityVisibility.treasuryAddressesKnown}; balances fetched=false; per-asset liabilities fetched=false.`);
  lines.push("- No official proof-of-reserves, reserve attestation, per-asset liabilities, reconciliation endpoint/dashboard, or documented explorer reserve schema was established.");
  lines.push(`- Reconciliation: ${raw.reserveLiabilityVisibility.reconciliationStatus}.`);
  lines.push(`- Deficit/surplus conclusion: ${raw.reserveLiabilityVisibility.deficitSurplusConclusion}.`);
  lines.push("- This is a visibility gap, not evidence of missing reserves or missing controls.");
  lines.push("");
  lines.push("## XPL / UXPL Alias Resolution");
  lines.push("");
  lines.push(`- ${raw.xplUxplAliasResolution.conclusion}`);
  lines.push("- Status: naming/venue alias caveat; operational route status is derived independently from canonical economics.");
  lines.push("");
  lines.push("## Local Economics Carry-Forward");
  lines.push("");
  lines.push(`- linkedTokensScanned=${raw.localCarryForward.linkedTokensScanned ?? "n/a"}; systemBalanceExceedsSupply=${raw.localCarryForward.systemBalanceExceedsSupply ?? "n/a"}.`);
  lines.push(`- consumerJoins=${raw.localCarryForward.consumerJoins ?? "n/a"}; HyperLend joins=${raw.localCarryForward.hyperlendJoins ?? "n/a"}.`);
  lines.push(`- Canonical Unit exact best=${raw.localCarryForward.bestExactNetUsd ?? "n/a"}; estimated best=${raw.localCarryForward.bestEstimatedNetUsd ?? "n/a"}; evidence=${raw.routeEvidenceStatus}.`);
  lines.push("| Asset | Max DEX liquidity | Max borrow cash | Best exact net | Route |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const row of raw.localCarryForward.keyAssetEconomics) {
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
  lines.push("No route, executor, fork, transaction, signed-action, aggregate route sweep, or completion-gate promotion is justified. Six-proxy implementation coverage and reserve/liability evidence remain incomplete.");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const generatedAt = new Date().toISOString();
  const loaded = loadArtifactManifest(WORKSPACE, SOURCE_ARTIFACT_SPECS, new Date(generatedAt));
  const artifacts = loaded.artifacts;
  const sourceArtifacts = Object.fromEntries(loaded.manifest.map((entry) => [entry.path, entry]));

  const step2Json = artifacts["reports/raw/fast/unit-proof-custody-accounting.json"].json;
  const depthPath = "reports/raw/fast/hyperliquid-core-dex-depth-routes.json";
  const routeSummary = deriveUnitRouteSummary(artifacts[depthPath].json, sourceArtifacts[depthPath]);
  const implementationScope = implementationCoverage(PUBLIC_CONTRACT_ROWS.filter((row) => row.implementationAddress).map((row) => row.symbol));
  const verifiedSourceCoverage = implementationCoverage(PUBLIC_CONTRACT_ROWS.filter((row) => row.implementationSourceVerification === "verified-exact-match").map((row) => row.symbol));
  const canonicalProxyCoverage = validateObservedProxyCoverage(artifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].json);
  const combinedCoverage = { complete: implementationScope.complete && canonicalProxyCoverage.complete };
  const checkpoint = buildIntegrityCheckpoint({
    manifest: loaded.manifest,
    routeSummary,
    coverage: combinedCoverage,
    mandatoryDomains: {
      economics: routeSummary.routeEvidenceStatus,
      implementation: "unknown",
      reserveBacking: "unknown",
      liabilities: "unknown",
    },
  });
  const operationalOutput = buildOperationalOutputSummary(routeSummary, []);
  const raw = {
    generatedAt,
    scanner: SCANNER,
    scope: "Unit / Hyperunit step-3 implementation/source and reserve/liability endpoint discovery; deterministic local reduction and static public facts only",
    safety: {
      readOnlyResearch: true,
      deterministicLocalReduction: true,
      externalHttpFetched: false,
      networkCalls: false,
      generateAddressCalled: false,
      operationsAddressCalled: false,
      endpointEnumerationPerformed: false,
      endpointInventoriesRead: false,
      rpcInventoryRead: false,
      graphqlInventoryRead: false,
      envFilesRead: false,
      privateKeysRead: false,
      keyFilesRead: false,
      pemFilesRead: false,
      sourceChainBalanceQueries: false,
      roleEthCalls: false,
      signedActions: false,
      walletOps: false,
      exploitExecuteCalls: false,
      calldataExecuted: false,
      forkTransactions: false,
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
    officialSourceVisibility: {
      officialImplementationRepository: "not-established",
      officialSdkOrPackageReference: "not-found-in-reviewed-current-docs-index",
      unitxyzRepositoryStatus: "public-repository-exists-implementation-relevance-not-established",
      guardianAgentSource: "not-established",
      chainServicesSource: "not-established",
      flowManagerSource: "not-established",
      consensusServiceSource: "not-established",
      walletManagerSource: "not-established",
      publicMintImplementationReference: "not-found",
      publicBurnImplementationReference: "not-found",
      absenceInference: "Do not infer implementation or authority is absent from lack of an established official public source reference.",
    },
    publicContractRows: PUBLIC_CONTRACT_ROWS,
    implementationCoverage: implementationScope,
    verifiedSourceCoverage,
    canonicalProxyCoverage,
    controlSurfaceRows: buildControlSurfaceRows(),
    endpointCandidateRows: ENDPOINT_CANDIDATE_ROWS,
    reserveLiabilityVisibility: buildReserveLiabilityVisibility(step2Json),
    xplUxplAliasResolution: {
      docsSymbol: "XPL",
      venueDisplaySymbol: "UXPL",
      fullName: "Unit Plasma",
      tokenId: "0x2c54c60600e1d786b2dfc139a38a5a99",
      step1SpotMetaHyperEvmAddress: "0x33af3c2540ba72054e044efe504867b39ae421f5",
      status: "naming-venue-alias-caveat",
      conclusion: "Treat XPL as the official docs/native Unit symbol and UXPL as the Hyperliquid venue/display symbol until a formal mapping is published; this supersedes a route-significant discrepancy interpretation.",
      routePositive: 0,
    },
    auditDisclosureVisibility: {
      officialPublicAuditReportFound: false,
      officialBugBountyFound: false,
      officialResponsibleDisclosurePolicyFound: false,
      unitSpecificIncidentPostmortemFound: false,
      classification: "coverage-gap-not-evidence-controls-absent",
      caveat: "Reviewed current public docs did not establish these materials; do not infer none exist outside reviewed sources.",
    },
    localCarryForward: buildLocalCarryForward(artifacts, routeSummary),
    routeSummary,
    operationalOutput,
    ...checkpoint,
    blockers: [
      "No official Unit bridge/agent/contracts implementation repository or SDK/schema was established from reviewed current public docs.",
      "UBTC implementation source is unverified; UETH/USOL verified control surfaces do not expose a documented mint/burn method, but issuance authority cannot be inferred from ABI absence.",
      "Current owner, proxy admin, compliance authority, HyperCore deployer, minter, and burner values remain unresolved-not-queried by scope.",
      "Treasury addresses are known, but source-chain and HyperCore balances plus per-asset wrapped liabilities were not fetched or reconciled.",
      "No official proof-of-reserves, per-asset liabilities, reserve attestation, reconciliation endpoint/dashboard, or documented explorer aggregate reserve schema was established.",
      "Safe aggregate endpoint candidates were classified but not fetched; gated and user-specific endpoints were not called.",
      "Canonical economics status is derived separately and does not resolve the unknown implementation, reserve, or accounting domains.",
    ],
    requiredForRoutePositive: [
      "Authoritative implementation/source or verified deployed logic establishing the actual Unit mint, burn, upgrade, proof, and accounting paths.",
      "Current role values and authority transitions established through separately authorized safe read-only evidence, without signed actions.",
      "Current source-chain treasury balances, HyperCore treasury balances, wrapped supplies, and per-asset liabilities reconciled from authoritative public/read-only sources.",
      "A concrete permissionless implementation or accounting flaw producing unbacked/over-credited assets, not merely absent public source or disclosure coverage.",
      "Exact positive consumer/DEX/lending exit economics after LTV, liquidity, slippage, delay, fees, and gas, plus local positive-value proof before any gate promotion.",
    ],
    nextReadOnlyStep: "If separately authorized, perform a bounded static verification of the UETH/USOL verified implementations and documented proxy upgrade history, or identify an authoritative aggregate reserve/liability schema; do not query roles, balances, user-specific operations, or change route gates in this step.",
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
  console.log(`contracts=${raw.publicContractRows.length} implementationCoverage=${raw.implementationCoverage.reviewedProxyCount}/6 verifiedSourceCoverage=${raw.verifiedSourceCoverage.reviewedProxyCount}/6 routeEvidenceStatus=${raw.routeEvidenceStatus} routePositiveOperational=${raw.routePositiveOperational} executableNow=0 signedActionJustified=false`);
}

main();
