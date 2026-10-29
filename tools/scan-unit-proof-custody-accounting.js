#!/usr/bin/env node
"use strict";

// Unit / Hyperunit step-2 proof/custody/accounting discovery.
// Deterministic local artifact reducer plus static public-doc facts supplied for this step.
// No endpoint inventories, env/key material, live transactions, calldata execution, forks,
// signed actions, wallet ops, generate-address calls, or aggregate gate promotion.

const fs = require("fs");
const path = require("path");
const {
  FRESHNESS_POLICY,
  buildIntegrityCheckpoint,
  buildOperationalOutputSummary,
  deriveUnitRouteSummary,
  loadArtifactManifest,
  resolveCanonicalAsset,
} = require("./lib/unit-audit-integrity");

const WORKSPACE = path.resolve(__dirname, "..");
const SCANNER = "tools/scan-unit-proof-custody-accounting.js";
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "unit-proof-custody-accounting.json");
const OUT_MD = path.join(WORKSPACE, "reports", "unit-proof-custody-accounting-triage.md");

const ALLOWED_WRITES = new Set([
  "reports/raw/fast/unit-proof-custody-accounting.json",
  "reports/unit-proof-custody-accounting-triage.md",
]);

const SOURCE_ARTIFACTS = [
  "reports/raw/fast/unit-readonly-discovery.json",
  "reports/raw/fast/hyperliquid-linked-token-invariants.json",
  "reports/raw/fast/hyperliquid-linked-token-consumers.json",
  "reports/raw/fast/hyperliquid-core-dex-depth-routes.json",
  "reports/raw/fast/bridge-proof-binding.json",
  "reports/raw/fast/bridge-delta-preflight.json",
  "reports/raw/fast/bridge-lending-collateral-join.json",
];

const SOURCE_ARTIFACT_SPECS = SOURCE_ARTIFACTS.map((artifactPath) => ({
  path: artifactPath,
  required: [
    "reports/raw/fast/unit-readonly-discovery.json",
    "reports/raw/fast/hyperliquid-linked-token-invariants.json",
    "reports/raw/fast/hyperliquid-linked-token-consumers.json",
    "reports/raw/fast/hyperliquid-core-dex-depth-routes.json",
  ].includes(artifactPath),
  evidenceClass: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json") ? "marketEconomics"
    : (artifactPath.endsWith("unit-readonly-discovery.json") ? "derived"
      : (["reports/raw/fast/hyperliquid-linked-token-invariants.json", "reports/raw/fast/hyperliquid-linked-token-consumers.json"].includes(artifactPath) ? "dynamicSnapshot" : "static")),
  requiredPaths: artifactPath.endsWith("unit-readonly-discovery.json")
    ? ["generatedAt", "unitAssetRows", "routeEvidenceStatus"]
    : (artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json") ? ["generatedAt", "rows"] : ["generatedAt", "summary"]),
  requiredTypes: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json") ? { rows: "array" } : {},
}));

const STATIC_SOURCE_URLS = {
  docsIndex: "https://docs.hyperunit.xyz/llms.txt",
  architectureOverview: "https://docs.hyperunit.xyz/architecture/quickstart.md",
  components: "https://docs.hyperunit.xyz/architecture/components.md",
  security: "https://docs.hyperunit.xyz/architecture/security.md",
  apiOverview: "https://docs.hyperunit.xyz/developers/api.md",
  generateAddress: "https://docs.hyperunit.xyz/developers/api/generate-address.md",
  guardianSignatures: "https://docs.hyperunit.xyz/developers/api/generate-address/guardian-signatures.md",
  operations: "https://docs.hyperunit.xyz/developers/api/operations.md",
  depositLifecycle: "https://docs.hyperunit.xyz/developers/api/operations/deposit-lifecycle.md",
  withdrawalLifecycle: "https://docs.hyperunit.xyz/developers/api/operations/withdrawal-lifecycle.md",
  withdrawalQueue: "https://docs.hyperunit.xyz/developers/api/withdraw-queue.md",
  estimateFees: "https://docs.hyperunit.xyz/developers/api/estimate-fees.md",
  mainnetKeyAddresses: "https://docs.hyperunit.xyz/developers/key-addresses/mainnet.md",
  mainnetTokenMetadata: "https://docs.hyperunit.xyz/developers/key-addresses/mainnet/token-metadata.md",
};

const TREASURY_ADDRESS_ROWS = [
  { sourceChain: "Bitcoin", nativeChainTreasury: "bc1pdwu79dady576y3fupmm82m3g7p2p9f6hgyeqy0tdg7ztxg7xrayqlkl8j9", hyperCoreTreasury: "0x574bAFCe69d9411f662a433896e74e4F153096FA" },
  { sourceChain: "Ethereum", nativeChainTreasury: "0xBEa9f7FD27f4EE20066F18DEF0bc586eC221055A", hyperCoreTreasury: "0x8DAfBe89302656a7Df43c470e9EbCB4c540835c0" },
  { sourceChain: "Solana", nativeChainTreasury: "9SLPTL41SPsYkgdsMzdfJsxymEANKr5bYoBsQzJyKpKS", hyperCoreTreasury: "0xA822a9cEB6D6CB5b565bD10098AbCFA9Cf18D748" },
  { sourceChain: "Plasma", nativeChainTreasury: "0x8e88826F42A0f5f199a9c91C3798c626326730b4", hyperCoreTreasury: "0xE6111266AfdcdF0b1fE8505028cC1f7419d798a7" },
  { sourceChain: "Monad", nativeChainTreasury: "0x4213de5c3C01eB3D757e271D4BEBc999F996E3D5", hyperCoreTreasury: "0x24DE6B77e8bc31c40Aa452926daa6BBaB7a71B0f" },
  { sourceChain: "Zcash", nativeChainTreasury: "t1KbKkQ7WisJF52sSepMjYokQJbkJCJ1i3C", hyperCoreTreasury: "0x54cd89623888e8010fdEa1C62e86265A9c6dA950" },
  { sourceChain: "Avalanche", nativeChainTreasury: "0x84e49dDcAD2eBFE7474Fa7A3d3eb1fe8bC103A16", hyperCoreTreasury: "0x1c498A93b145e7a73d69691e9023F6f308e1CC3F" },
  { sourceChain: "Base", nativeChainTreasury: "0x749b898E5B523f08E9e371D259e0409c19AE8454", hyperCoreTreasury: "0x8d68eFBf06fb8cf932518bcB53705E674C4852DC" },
];

const FEE_PAYERS = [
  "0xd6FB008b153ccb78D615941F982f38a1c67cE270",
  "0x2fB00942D628FEcD6aBb933C1173eEd2dD6Fe2f4",
];

const TOKEN_METADATA_ROWS = [
  { asset: "BTC", unitSymbol: "UBTC", name: "Unit Bitcoin", sourceChain: "Bitcoin", network: "Bitcoin", tokenId: "0x8f254b963e8468305d409b33aa137c67", hyperEvmToken: "0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463" },
  { asset: "ETH", unitSymbol: "UETH", name: "Unit Ethereum", sourceChain: "Ethereum", network: "Ethereum Mainnet", tokenId: "0xe1edd30daaf5caac3fe63569e24748da", hyperEvmToken: "0xBe6727B535545C67d5cAa73dEa54865B92CF7907" },
  { asset: "SOL", unitSymbol: "USOL", name: "Unit Solana", sourceChain: "Solana", network: "Solana Mainnet Beta", tokenId: "0x49b67c39f5566535de22b29b0e51e685", hyperEvmToken: "0x068f321Fa8Fb9f0D135f290Ef6a3e2813e1c8A29" },
  { asset: "PUMP", unitSymbol: "UPUMP", name: "Unit Pump Fun", sourceChain: "Solana", network: "Solana Mainnet Beta", tokenId: "0x544e60f98a36d7b22c0fb5824b84f795", hyperEvmToken: "0x27eC642013bcB3D80CA3706599D3cdA04F6f4452" },
  { asset: "FARTCOIN", unitSymbol: "UFART", name: "Unit Fartcoin", sourceChain: "Solana", network: "Solana Mainnet Beta", tokenId: "0x7650808198966e4285687d3deb556ccc", hyperEvmToken: "0x3B4575E689DEd21CAAD31d64C4df1f10F3B2CedF" },
  { asset: "SPXS", unitSymbol: "UUUSPX", name: "Unit SPX6900", sourceChain: "Solana", network: "Solana Mainnet Beta", tokenId: "0x2ff71b802a6788a052c7f1a58ec863af", hyperEvmToken: null },
  { asset: "BONK", unitSymbol: "UBONK", name: "Unit Bonk", sourceChain: "Solana", network: "Solana Mainnet Beta", tokenId: "0xb113d34e351cf195733c98442530c099", hyperEvmToken: null },
  { asset: "XPL", unitSymbol: "XPL", step1Symbol: "UXPL", name: "Unit Plasma", sourceChain: "Plasma", network: "Plasma Mainnet", tokenId: "0x2c54c60600e1d786b2dfc139a38a5a99", hyperEvmToken: null },
  { asset: "ZEC", unitSymbol: "UZEC", name: "Unit Zcash", sourceChain: "Zcash", network: "Zcash Mainnet", tokenId: "0x1c994ad3381d31c86c8c2d74ed89a365", hyperEvmToken: null },
  { asset: "AVAX", unitSymbol: "UAVAX", name: "Unit Avalanche", sourceChain: "Avalanche", network: "Avalanche Mainnet", tokenId: "0x730fc3855fb77d2aa5a19dd7891dbe80", hyperEvmToken: null },
  { asset: "VIRTUAL", unitSymbol: "UVIRT", name: "Unit Virtual", sourceChain: "Base", network: "Base Mainnet", tokenId: "0x85b8124314ae77b78b4b6f20ecd93149", hyperEvmToken: null },
];

const FINALITY_THRESHOLD_ROWS = [
  { chain: "Bitcoin", globalApiTable: "3+", depositLifecycleExamples: "2", operationCreation: "1", withdrawalLifecycle: null, caveat: "Conflicting public thresholds; review finality config before relying on timing assumptions." },
  { chain: "Hyperliquid", globalApiTable: "2000", depositLifecycleExamples: "destination 10", operationCreation: "1", withdrawalLifecycle: "5000", caveat: "Source/destination/finality contexts differ across docs." },
  { chain: "Ethereum", globalApiTable: "14", depositLifecycleExamples: "14", operationCreation: "8", withdrawalLifecycle: null, caveat: "Operation-creation threshold differs from lifecycle/global rows." },
  { chain: "Solana", globalApiTable: "32", depositLifecycleExamples: "32", operationCreation: null, withdrawalLifecycle: null, caveat: "Consistent across listed deposit examples and global table." },
  { chain: "Plasma", globalApiTable: "3", depositLifecycleExamples: null, operationCreation: null, withdrawalLifecycle: null, caveat: "Only global API table context recorded." },
  { chain: "Monad", globalApiTable: "5", depositLifecycleExamples: null, operationCreation: null, withdrawalLifecycle: null, caveat: "Only global API table context recorded." },
  { chain: "Zcash", globalApiTable: "100", depositLifecycleExamples: null, operationCreation: null, withdrawalLifecycle: null, caveat: "Only global API table context recorded." },
  { chain: "Avalanche", globalApiTable: "15", depositLifecycleExamples: null, operationCreation: null, withdrawalLifecycle: null, caveat: "Only global API table context recorded." },
  { chain: "Base", globalApiTable: "140+", depositLifecycleExamples: null, operationCreation: null, withdrawalLifecycle: null, caveat: "Only global API table context recorded." },
];

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function assertAllowedWrite(file) {
  const r = rel(path.resolve(file));
  if (!ALLOWED_WRITES.has(r)) throw new Error(`Refusing to write outside Unit step-2 ownership: ${r}`);
}

function writeAllowed(file, text) {
  assertAllowedWrite(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function round(value, decimals = 4) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
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

function md(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\n/g, " ");
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
    info.scope = typeof json.scope === "string" ? json.scope : (json.scope && (json.scope.source || json.scope.topNUniverse)) || null;
    const summary = json.summary || {};
    const safety = json.safety || {};
    info.routePositive = summary.routePositive ?? safety.routePositive ?? json.routePositive ?? null;
    info.executableNow = summary.executableNow ?? safety.executableNow ?? json.executableNow ?? null;
    info.signedActionJustified = summary.signedActionJustified ?? safety.signedActionJustified ?? json.signedActionJustified ?? null;
    info.summary = pick(summary, [
      "hyperCoreTokens", "linkedTokensScanned", "systemBalanceExceedsSupply", "watchCandidates", "reviewCandidates",
      "joinedRows", "consumerJoins", "hyperlendJoins", "yieldJoins", "dexJoins", "researchPositiveRows",
      "routePositive", "executableNow", "signedActionJustified", "targetsScanned", "depthAvailable",
      "exactDexQuoteRows", "multiHopExactRows", "bestNetUsd", "bestExactNetUsd", "proofRows", "highStaticRows",
      "underBoundProofRows", "deployedProofAcceptanceRows", "liquidMintUnlockRows", "exactEconomicsRows",
      "forkProofRows", "bridgeTokens", "lendingConsumers", "joinedRows", "topLiquidityUsd", "concreteMismatchRows",
      "materialMismatchRows", "routePositiveCandidates",
    ]);
    if (relPath.endsWith("unit-readonly-discovery.json")) {
      info.summary = {
        unitAssetRows: Array.isArray(json.unitAssetRows) ? json.unitAssetRows.length : null,
        publicHttpRead: json.safety && json.safety.publicHttpRead,
        spotMetaOk: json.publicHttp && json.publicHttp.hyperliquidSpotMeta && json.publicHttp.hyperliquidSpotMeta.ok,
        routePositive: json.routePositive ?? 0,
        executableNow: json.executableNow ?? 0,
        signedActionJustified: json.signedActionJustified ?? false,
      };
    }
    return { info, json };
  } catch (err) {
    info.present = fs.existsSync(file);
    info.error = err && err.message ? err.message : String(err);
    return { info, json: null };
  }
}

function normalizedAddress(value) {
  return value ? String(value).toLowerCase() : null;
}

function findStep1Asset(step1Json, tokenMetadata) {
  const rows = Array.isArray(step1Json && step1Json.unitAssetRows) ? step1Json.unitAssetRows : [];
  const tokenId = normalizedAddress(tokenMetadata.tokenId);
  const match = rows.find((row) => tokenId && normalizedAddress(row.tokenId) === tokenId) || null;
  return match && resolveCanonicalAsset(match).ok ? match : null;
}

function treasuryForSource(sourceChain) {
  return TREASURY_ADDRESS_ROWS.find((row) => row.sourceChain.toLowerCase() === String(sourceChain || "").toLowerCase()) || null;
}

function buildMetadataDiscrepancies(step1Json) {
  const out = [];
  for (const token of TOKEN_METADATA_ROWS) {
    const step1 = findStep1Asset(step1Json, token);
    const metadataAddress = normalizedAddress(token.hyperEvmToken);
    const step1Address = normalizedAddress(step1 && step1.hyperevmContract);
    if (!metadataAddress && step1Address) {
      out.push({
        asset: token.asset,
        metadataSymbol: token.unitSymbol,
        step1Symbol: step1.symbol,
        tokenId: token.tokenId,
        metadataHyperEvmToken: token.hyperEvmToken,
        step1HyperEvmToken: step1.hyperevmContract,
        status: "metadata-discrepancy-watch-only",
        routePositive: 0,
        note: "Mainnet token metadata lists no HyperEVM token, but the step-1 canonical local registry records a HyperEVM contract. This is a documentation/metadata caveat only, not an accounting bypass.",
      });
    } else if (metadataAddress && step1Address && metadataAddress !== step1Address) {
      out.push({
        asset: token.asset,
        metadataSymbol: token.unitSymbol,
        step1Symbol: step1.symbol,
        tokenId: token.tokenId,
        metadataHyperEvmToken: token.hyperEvmToken,
        step1HyperEvmToken: step1.hyperevmContract,
        status: "address-case-or-value-discrepancy-watch-only",
        routePositive: 0,
        note: "Metadata and step-1 canonical local registry addresses differ after normalization; verify authoritative metadata before relying on this row.",
      });
    }
  }
  return out;
}

function buildCustodyReconciliationRows(step1Json) {
  return TOKEN_METADATA_ROWS.map((token) => {
    const treasury = treasuryForSource(token.sourceChain);
    const step1 = findStep1Asset(step1Json, token);
    const metrics = step1 && step1.summarizedMetrics ? step1.summarizedMetrics : {};
    const metadataDiscrepancy = !token.hyperEvmToken && step1 && step1.hyperevmContract
      ? "metadata-discrepancy-watch-only"
      : "none";
    return {
      asset: token.asset,
      unitSymbol: token.unitSymbol,
      step1Symbol: step1 ? step1.symbol : token.step1Symbol || token.unitSymbol,
      sourceChain: token.sourceChain,
      network: token.network,
      tokenId: token.tokenId,
      nativeChainTreasury: treasury ? treasury.nativeChainTreasury : null,
      hyperCoreTreasury: treasury ? treasury.hyperCoreTreasury : null,
      metadataHyperEvmToken: token.hyperEvmToken,
      step1HyperEvmToken: step1 ? step1.hyperevmContract : null,
      step1Markets: step1 && Array.isArray(step1.markets) ? step1.markets : [],
      step1MaxDexLiquidityUsd: round(metrics.maxDexLiquidityUsd, 2),
      step1MaxBorrowCashUsd: round(metrics.maxBorrowCashUsd, 2),
      step1BestExactNetUsd: round(metrics.bestExactNetUsd, 4),
      balanceStatus: treasury ? "treasury-address-known-balance-not-fetched" : "treasury-address-not-known-for-source-chain",
      backingStatus: "cannot-reconcile-backing-without-source-chain-balances-and-wrapped-liabilities",
      accountingStatus: "mint-burn-liability-endpoint-not-found",
      metadataDiscrepancy,
      routeImpact: "cannot prove surplus/deficit without source-chain balances and wrapped liabilities",
      routePositive: metrics.routePositive ? 1 : 0,
    };
  });
}

function buildProofBindingMatrix() {
  return [
    { binding: "guardian node/domain", legacyPayload: true, newPayload: true, docsEvidence: "Both payloads prefix nodeId.", gap: "Does not replace chain proof validation.", routeImpact: "not route-positive" },
    { binding: "sourceChain", legacyPayload: true, newPayload: "implicit-via-coinType/address-context", docsEvidence: "Legacy payload appends sourceChain; new payload has user/coinType/destinationChain/destinationAddress/address.", gap: "New payload does not explicitly include sourceChain label.", routeImpact: "review-caveat-only" },
    { binding: "destinationChain", legacyPayload: true, newPayload: true, docsEvidence: "Both payloads include destination chain.", gap: "Destination chain binding is documented for address generation, not full mint proof.", routeImpact: "not route-positive" },
    { binding: "destinationRecipient", legacyPayload: true, newPayload: true, docsEvidence: "destinationAddress is signed.", gap: "No evidence recipient can be swapped.", routeImpact: "not route-positive" },
    { binding: "asset-or-coinType", legacyPayload: true, newPayload: true, docsEvidence: "Legacy includes asset; new includes coinType.", gap: "Token binding for eventual mint transaction remains unresolved.", routeImpact: "not route-positive" },
    { binding: "generatedProtocolAddress", legacyPayload: true, newPayload: true, docsEvidence: "Generated address is signed.", gap: "User-specific /gen endpoint was not called by this scanner.", routeImpact: "not route-positive" },
    { binding: "amount", legacyPayload: false, newPayload: false, docsEvidence: "Address-generation signatures do not include deposit amount.", gap: "Amount binding must be enforced later by source-chain observation and destination tx construction.", routeImpact: "unresolved-accounting-caveat" },
    { binding: "nonce/replay", legacyPayload: false, newPayload: false, docsEvidence: "Address-generation signatures do not include nonce.", gap: "No public replay nonce/message schema resolved.", routeImpact: "unresolved-proof-caveat" },
    { binding: "source transaction hash", legacyPayload: false, newPayload: false, docsEvidence: "Address-generation signatures are pre-deposit address attestations.", gap: "Deposit operation proof/schema remains unresolved.", routeImpact: "unresolved-proof-caveat" },
    { binding: "finality threshold", legacyPayload: false, newPayload: false, docsEvidence: "Finality is lifecycle state/config, not address-generation signature material.", gap: "Threshold docs conflict by page/context.", routeImpact: "review-caveat-only" },
  ];
}

function buildLocalEconomicsCarryForward(artifacts, step1Json, routeSummary) {
  const step1Summary = artifacts["reports/raw/fast/unit-readonly-discovery.json"].info.summary || {};
  const invariants = artifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].info.summary || {};
  const consumers = artifacts["reports/raw/fast/hyperliquid-linked-token-consumers.json"].info.summary || {};
  const depth = artifacts["reports/raw/fast/hyperliquid-core-dex-depth-routes.json"].info.summary?.globalSourceContextNotUnitSummary || {};
  const unitRows = Array.isArray(step1Json && step1Json.unitAssetRows) ? step1Json.unitAssetRows : [];
  const keyAssets = unitRows
    .filter((row) => ["UBTC", "UETH", "USOL"].includes(String(row.symbol || "").toUpperCase()))
    .map((row) => ({
      symbol: row.symbol,
      maxDexLiquidityUsd: round(row.summarizedMetrics && row.summarizedMetrics.maxDexLiquidityUsd, 2),
      maxBorrowCashUsd: round(row.summarizedMetrics && row.summarizedMetrics.maxBorrowCashUsd, 2),
      bestExactNetUsd: round(row.summarizedMetrics && row.summarizedMetrics.bestExactNetUsd, 4),
      routePositive: row.summarizedMetrics && row.summarizedMetrics.routePositive ? 1 : 0,
    }));
  return {
    unitStep1: { ...step1Summary, unitAssetRows: unitRows.length },
    linkedTokenInvariants: invariants,
    linkedTokenConsumers: consumers,
    globalDepthSourceContextNotUnitSummary: depth,
    keyUnitAssets: keyAssets,
    canonicalUnitRouteSummary: routeSummary,
    bestExactNetUsd: routeSummary.bestExactUnitRoute?.netUsd ?? null,
    bestEstimatedNetUsd: routeSummary.bestEstimatedUnitRoute?.netUsd ?? null,
    conclusion: "Step-1 context carries forward as watch-only; stale economics cannot establish negative evidence or operational promotion.",
    routePositive: routeSummary.routePositiveOperational,
    executableNow: 0,
    signedActionJustified: false,
  };
}

function buildAccountingGaps() {
  return [
    { gap: "onchain light-client verifier", status: "not-found-in-public-docs", routeImpact: "guardian/indexer/consensus/MPC model cannot be treated as permissionless proof bypass without a concrete flaw" },
    { gap: "mint authorization path", status: "unresolved", routeImpact: "cannot test or prove unbacked mint path" },
    { gap: "burn mechanics and liabilities decrement", status: "unresolved", routeImpact: "cannot reconcile redemption accounting" },
    { gap: "proof-of-reserves/backing endpoint", status: "not-found", routeImpact: "cannot compare source-chain reserves to wrapped liabilities" },
    { gap: "per-asset liabilities dashboard/API", status: "not-found", routeImpact: "cannot prove surplus/deficit" },
    { gap: "source-chain balance fetch", status: "not-performed-by-scope", routeImpact: "step-2 is deterministic/static; no balances fetched" },
    { gap: "finality threshold consistency", status: "review-caveat", routeImpact: "documentation discrepancy only; no route-positive timing exploit proven" },
  ];
}

function renderReport(raw) {
  const lines = [];
  lines.push("# Unit / Hyperunit Proof-Custody-Accounting Discovery");
  lines.push("");
  lines.push(`Signal: ${raw.operationalOutput.signalLabel} — auditClassification=${raw.auditClassification}, routeEvidenceStatus=${raw.routeEvidenceStatus}, routePositiveOperational=${raw.routePositiveOperational}, executableNow=0, signedActionJustified=false.`);
  lines.push("");
  lines.push("## Scope / Safety");
  lines.push("");
  lines.push(`- Scanner: \`${raw.scanner}\`, generated \`${raw.generatedAt}\`.`);
  lines.push("- Step 2 only: deterministic/local artifact reduction plus static public-doc facts. No external HTTP fetches were performed.");
  lines.push("- No `.env`, endpoint inventories, key files, generate-address calls, transactions, calldata execution, forks, wallets, aggregate gate promotion, or signed actions.");
  lines.push(`- Evidence complete=${raw.evidenceComplete}; closure eligible=${raw.closureEligible}; required artifact failures/staleness always resolve to unknown.`);
  lines.push("");
  lines.push("## Public Proof Model");
  lines.push("");
  lines.push(`- Model: ${raw.guardianModel.model}.`);
  lines.push(`- Initial guardians: ${raw.guardianModel.initialGuardians.join(", ")}; threshold: ${raw.guardianModel.threshold}.`);
  lines.push("- Public docs describe guardians running agents/indexers, independently verifying chain data, consensus, and MPC/TSS signing. No publicly documented onchain light-client verifier was resolved.");
  lines.push(`- Deposit lifecycle: ${raw.lifecycleModel.depositStates.join(" → ")}.`);
  lines.push(`- Withdrawal lifecycle: ${raw.lifecycleModel.withdrawalStates.join(" → ")}.`);
  lines.push("- Mint and burn mechanics remain unresolved from public docs; this is a blocker, not proof of a bypass.");
  lines.push("");
  lines.push("## Address / Signature Binding Matrix");
  lines.push("");
  lines.push("| Binding | Legacy payload | New payload | Gap | Route impact |");
  lines.push("|---|---|---|---|---|");
  for (const row of raw.proofBindingMatrix) {
    lines.push(`| ${md(row.binding)} | ${md(row.legacyPayload)} | ${md(row.newPayload)} | ${md(row.gap)} | ${md(row.routeImpact)} |`);
  }
  lines.push("");
  lines.push("## Finality Thresholds and Caveats");
  lines.push("");
  lines.push("| Chain | Global API | Deposit examples | Operation creation | Withdrawal lifecycle | Caveat |");
  lines.push("|---|---:|---:|---:|---:|---|");
  for (const row of raw.finalityThresholds.rows) {
    lines.push(`| ${md(row.chain)} | ${md(row.globalApiTable)} | ${md(row.depositLifecycleExamples || "")} | ${md(row.operationCreation || "")} | ${md(row.withdrawalLifecycle || "")} | ${md(row.caveat)} |`);
  }
  lines.push("");
  lines.push("## Treasury / Token Metadata Table");
  lines.push("");
  lines.push("| Asset | Unit symbol | Source chain | Native treasury | HyperCore treasury | Metadata HyperEVM | Step-1 HyperEVM | Status |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const row of raw.custodyReconciliationRows) {
    lines.push(`| ${md(row.asset)} | ${md(row.unitSymbol)} | ${md(row.sourceChain)} | ${md(row.nativeChainTreasury || "n/a")} | ${md(row.hyperCoreTreasury || "n/a")} | ${md(row.metadataHyperEvmToken || "none")} | ${md(row.step1HyperEvmToken || "none")} | ${md(row.metadataDiscrepancy)} |`);
  }
  lines.push("");
  lines.push("## Custody Reconciliation Status");
  lines.push("");
  lines.push("- Treasury addresses are known from static public docs, but balances were not fetched by scope.");
  lines.push("- Backing remains unreconciled because source-chain balances and per-asset wrapped liabilities were not joined.");
  lines.push("- systemBalance<=totalSupply is only a local ERC20 sanity check using raw integer/BigInt evidence; it is non-probative for native reserve/liability backing.");
  lines.push("- Metadata discrepancy: XPL metadata lists no HyperEVM token, while the step-1 canonical local registry records the UXPL HyperEVM proxy; this is watch-only and not route-positive.");
  lines.push("- UMON and SPXS/UUUSPX are distinct canonical assets with different strong token identifiers; no symbol-only first-match or alias is permitted.");
  lines.push("- XPL and UXPL are display aliases only when tokenId/index identity agrees; symbol alone is insufficient.");
  lines.push("");
  lines.push("## Local Economics Carry-Forward");
  lines.push("");
  lines.push(`- Unit step 1 assets: ${raw.localEconomicsCarryForward.unitStep1.unitAssetRows ?? "n/a"}; routePositiveOperational=${raw.routePositiveOperational}.`);
  lines.push(`- Linked-token invariant source context: linkedTokensScanned=${raw.localEconomicsCarryForward.linkedTokenInvariants.linkedTokensScanned ?? "n/a"}, systemBalanceExceedsSupply=${raw.localEconomicsCarryForward.linkedTokenInvariants.systemBalanceExceedsSupply ?? "n/a"}, sourceArtifactRoutePositive=${raw.localEconomicsCarryForward.linkedTokenInvariants.routePositive ?? "n/a"}.`);
  lines.push(`- Consumer source context: consumerJoins=${raw.localEconomicsCarryForward.linkedTokenConsumers.consumerJoins ?? "n/a"}, hyperlendJoins=${raw.localEconomicsCarryForward.linkedTokenConsumers.hyperlendJoins ?? "n/a"}, sourceArtifactRoutePositive=${raw.localEconomicsCarryForward.linkedTokenConsumers.routePositive ?? "n/a"}.`);
  lines.push(`- Canonical Unit exact best=${raw.localEconomicsCarryForward.bestExactNetUsd ?? "n/a"}; estimated best=${raw.localEconomicsCarryForward.bestEstimatedNetUsd ?? "n/a"}; evidence=${raw.routeEvidenceStatus}.`);
  lines.push(`- ${raw.operationalOutput.narrative}`);
  lines.push("| Asset | Max DEX liq | Max borrow cash | Best exact net | Route |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const row of raw.localEconomicsCarryForward.keyUnitAssets) {
    lines.push(`| ${md(row.symbol)} | ${fmtUsd(row.maxDexLiquidityUsd)} | ${fmtUsd(row.maxBorrowCashUsd)} | ${fmtUsd(row.bestExactNetUsd)} | ${row.routePositive ?? 0} |`);
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const blocker of raw.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Required Before Route Positive");
  lines.push("");
  for (const req of raw.requiredForRoutePositive) lines.push(`- ${req}`);
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("");
  lines.push(`- ${raw.nextReadOnlyStep}`);
  lines.push("");
  lines.push("## Gate Status");
  lines.push("");
  lines.push("No aggregate gate promotion, fork, executor, signed action, transaction work, or route sweep update is justified. Mandatory proof/custody evidence remains unknown, so CLEAN is prohibited.");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const generatedAt = new Date().toISOString();
  const loaded = loadArtifactManifest(WORKSPACE, SOURCE_ARTIFACT_SPECS, new Date(generatedAt));
  const artifacts = loaded.artifacts;
  const sourceArtifacts = Object.fromEntries(loaded.manifest.map((entry) => [entry.path, entry]));

  const step1Json = artifacts["reports/raw/fast/unit-readonly-discovery.json"].json;
  const metadataDiscrepancies = buildMetadataDiscrepancies(step1Json);
  const custodyReconciliationRows = buildCustodyReconciliationRows(step1Json);
  const depthPath = "reports/raw/fast/hyperliquid-core-dex-depth-routes.json";
  const routeSummary = deriveUnitRouteSummary(artifacts[depthPath].json, sourceArtifacts[depthPath]);
  const localEconomicsCarryForward = buildLocalEconomicsCarryForward(artifacts, step1Json, routeSummary);
  const checkpoint = buildIntegrityCheckpoint({
    manifest: loaded.manifest,
    routeSummary,
    mandatoryDomains: {
      economics: routeSummary.routeEvidenceStatus,
      proofBinding: "unknown",
      custodyBacking: "unknown",
      mintBurnAccounting: "unknown",
    },
  });
  const operationalOutput = buildOperationalOutputSummary(routeSummary, [
    "No publicly documented onchain light-client proof verifier or proof format was resolved.",
    "Guardian/indexer/consensus/MPC model is documented, but no guardian-signing, consensus, or key-compromise bypass is proven.",
    "Address-generation signatures bind recipient/chain/asset/address context but not amount, nonce, source transaction hash, or finality threshold.",
    "Mint and burn authorization/accounting paths remain unresolved from public docs.",
    "Treasury addresses are known, but balances were not fetched and no source-chain reserve-to-wrapped-liability reconciliation was performed.",
    "XPL/UXPL HyperEVM metadata discrepancy is watch-only and does not prove surplus, deficit, or mint authority issue.",
    "Existing local economics remain net-negative or context-only; routePositive=0.",
  ]);

  const raw = {
    generatedAt,
    scanner: SCANNER,
    scope: "Unit / Hyperunit step-2 proof/custody/accounting discovery; deterministic static public-doc facts plus local artifact reduction only",
    safety: {
      readOnlyResearch: true,
      deterministicLocalReduction: true,
      externalHttpFetched: false,
      generateAddressCalled: false,
      endpointInventoriesRead: false,
      rpcInventoryRead: false,
      graphqlInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      keyFilesRead: false,
      pemFilesRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      calldataExecuted: false,
      forkTransactions: false,
      walletOps: false,
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
    guardianModel: {
      model: "guardian_indexer_consensus_mpc_not_public_onchain_light_client",
      initialGuardians: ["Unit", "Hyperliquid Labs", "Infinite Field"],
      threshold: "2-of-3 commonly documented",
      guardianResponsibilities: [
        "run Unit agent",
        "operate nodes/indexers for supported native chains",
        "independently verify blockchain data",
        "participate in consensus",
        "participate in MPC/TSS signing",
      ],
      controls: ["flow manager strict sequencing", "t-of-n consensus quorum", "wallet manager threshold signatures", "circuit breakers"],
      onchainLightClientVerifierFound: false,
      proofFormatResolved: false,
      routePositive: 0,
    },
    lifecycleModel: {
      depositStates: ["SourceTxDiscovered", "WaitForSrcTxFinalization", "BuildingDstTx", "AdditionalChecks", "SignTx", "BroadcastTx", "WaitForDstTxFinalization", "Done"],
      withdrawalStates: ["SourceTxDiscovered", "WaitForSrcTxFinalization", "ReadyForWithdrawQueue", "QueuedForWithdraw", "Done"],
      mintMechanics: "unresolved-public-docs-describe-destination-hyperliquid-tx-construction-signing-but-not-explicit-mint-contract-or-function",
      burnMechanics: "unresolved-public-docs-do-not-explicitly-describe-burn-fields-tx-or-contract",
      routePositive: 0,
    },
    addressGenerationBinding: {
      endpointDocumented: "GET /gen/:src_chain/:dst_chain/:asset/:dst_addr",
      calledByThisScanner: false,
      binds: ["source chain", "destination chain", "asset", "destination address", "generated protocol address"],
      notBoundInAddressSignature: ["amount", "nonce", "source transaction hash", "finality threshold"],
      safetyNote: "Not called because it can generate user-specific addresses.",
    },
    signatureVerification: {
      algorithm: "ECDSA P-256 over SHA-256",
      signatureEncoding: "base64 raw 64-byte signature",
      publicKeyFormat: "uncompressed P-256 public key",
      validGuardianSignaturesRequired: 2,
      legacyPayload: "${nodeId}:${[destinationAddress,destinationChain,asset,address,sourceChain,'deposit'].join('-')}",
      newPayload: "${nodeId}:${['user',coinType,destinationChain,destinationAddress,address].join('-')}",
      routePositive: 0,
    },
    finalityThresholds: {
      rows: FINALITY_THRESHOLD_ROWS,
      conclusion: "Finality docs contain context-dependent discrepancies. Treat as review caveat, not vulnerability or route-positive evidence.",
    },
    treasuryAddressRows: TREASURY_ADDRESS_ROWS,
    feePayers: FEE_PAYERS,
    tokenMetadataRows: TOKEN_METADATA_ROWS,
    canonicalIdentityReview: {
      umonVsSpxs: { status: "distinct-strong-identifiers-not-aliased", umonTokenId: "0x58dae745c8c5fed4012f35ef39829c2d", spxsTokenId: "0x2ff71b802a6788a052c7f1a58ec863af", symbolOnlyMatchingAllowed: false },
      xplVsUxpl: { status: "explicit-alias-requires-strong-identity", tokenId: "0x2c54c60600e1d786b2dfc139a38a5a99", symbolOnlyMatchingAllowed: false },
    },
    metadataDiscrepancies,
    proofBindingMatrix: buildProofBindingMatrix(),
    custodyReconciliationRows,
    accountingGaps: buildAccountingGaps(),
    localEconomicsCarryForward,
    routeSummary,
    operationalOutput,
    ...checkpoint,
    blockers: operationalOutput.blockers,
    requiredForRoutePositive: [
      "Authoritative deployed proof/mint/burn/accounting path with source/destination domain, nonce, token, amount, recipient, and finality binding.",
      "Source-chain treasury balances and per-asset wrapped liabilities fetched from safe public/read-only sources and reconciled to current supply.",
      "A permissionless flaw that allows forged deposit, replay, unbacked mint, wrong-recipient mint, or over-crediting without guardian/key compromise assumptions.",
      "Exact positive consumer/DEX/lending route economics after LTV, slippage, liquidity, delay, fees, and gas.",
      "Local proof artifact demonstrating positive value delta before any aggregate route gate, fork, executor, or signed-action consideration.",
    ],
    nextReadOnlyStep: "Resolve authoritative Unit mint/burn/proof/accounting implementation references or public reserve/liability endpoints; if unavailable, perform only a static docs/source diff and keep economics fail-closed.",
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
  console.log(`treasuryRows=${TREASURY_ADDRESS_ROWS.length} tokenRows=${TOKEN_METADATA_ROWS.length} metadataDiscrepancies=${metadataDiscrepancies.length} routeEvidenceStatus=${raw.routeEvidenceStatus} routePositiveOperational=${raw.routePositiveOperational} executableNow=0 signedActionJustified=false`);
}

main();
