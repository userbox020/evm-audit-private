#!/usr/bin/env node
"use strict";

// Unit / Hyperunit step-1 read-only discovery.
// No endpoint inventories, env files, keys, RPC/GraphQL inventories, calldata execution,
// fork transactions, signed actions, or aggregate route-gate updates.

const fs = require("fs");
const path = require("path");
const {
  CANONICAL_UNIT_ASSETS,
  FRESHNESS_POLICY,
  buildIntegrityCheckpoint,
  buildOperationalOutputSummary,
  deriveAssetRouteMetrics,
  deriveSupplySanity,
  deriveUnitRouteSummary,
  loadArtifactManifest,
  resolveCanonicalAsset,
  routeIsExact,
  validateObservedProxyCoverage,
} = require("./lib/unit-audit-integrity");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "unit-readonly-discovery.json");
const OUT_MD = path.join(WORKSPACE, "reports", "unit-readonly-discovery-triage.md");
const SCANNER = "tools/scan-unit-readonly-discovery.js";

const ALLOWED_WRITES = new Set([
  "reports/raw/fast/unit-readonly-discovery.json",
  "reports/unit-readonly-discovery-triage.md",
]);

const SOURCE_ARTIFACTS = [
  "reports/raw/fast/hyperliquid-linked-token-invariants.json",
  "reports/raw/fast/hyperliquid-linked-token-consumers.json",
  "reports/raw/fast/hyperliquid-core-dex-depth-routes.json",
  "reports/raw/fast/bridge-proof-binding.json",
  "reports/raw/fast/bridge-lending-collateral-join.json",
  "reports/raw/fast/bridge-delta-preflight.json",
  "reports/raw/fast/deep-research-exploit-target-discovery-2026-07-09.json",
];

const SOURCE_ARTIFACT_SPECS = SOURCE_ARTIFACTS.map((artifactPath) => ({
  path: artifactPath,
  required: [
    "reports/raw/fast/hyperliquid-linked-token-invariants.json",
    "reports/raw/fast/hyperliquid-linked-token-consumers.json",
    "reports/raw/fast/hyperliquid-core-dex-depth-routes.json",
  ].includes(artifactPath),
  evidenceClass: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json") ? "marketEconomics"
    : (["reports/raw/fast/hyperliquid-linked-token-invariants.json", "reports/raw/fast/hyperliquid-linked-token-consumers.json"].includes(artifactPath) ? "dynamicSnapshot" : "static"),
  requiredPaths: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json") ? ["generatedAt", "rows"] : ["generatedAt", "summary"],
  requiredTypes: artifactPath.endsWith("hyperliquid-core-dex-depth-routes.json") ? { rows: "array" } : {},
}));

const UNIT_ASSET_SEEDS = [
  { symbol: "UBTC", name: "Unit Bitcoin", sourceChain: "Bitcoin", tokenIndex: 197, tokenId: "0x8f254b963e8468305d409b33aa137c67", hyperevmContract: "0x9fdbda0a5e284c32744d2f17ee5c74b284993463", markets: ["@142/USDC", "@234/USDH"] },
  { symbol: "UETH", name: "Unit Ethereum", sourceChain: "Ethereum", tokenIndex: 221, tokenId: "0xe1edd30daaf5caac3fe63569e24748da", hyperevmContract: "0xbe6727b535545c67d5caa73dea54865b92cf7907", markets: ["@151/USDC", "@235/USDH"] },
  { symbol: "USOL", name: "Unit Solana", sourceChain: "Solana", tokenIndex: 254, tokenId: "0x49b67c39f5566535de22b29b0e51e685", hyperevmContract: "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29", markets: ["@156/USDC"] },
  { symbol: "UFART", name: "Unit Fartcoin", sourceChain: "Solana", tokenIndex: 269, tokenId: "0x7650808198966e4285687d3deb556ccc", hyperevmContract: "0x3b4575e689ded21caad31d64c4df1f10f3b2cedf", markets: ["@162/USDC"] },
  { symbol: "UPUMP", name: "Unit Pump", sourceChain: "Solana", tokenIndex: 299, tokenId: "0x544e60f98a36d7b22c0fb5824b84f795", hyperevmContract: "0x27ec642013bcb3d80ca3706599d3cda04f6f4452", markets: ["@188/USDC"] },
  { symbol: "UBONK", name: "Unit Bonk", sourceChain: "Solana", tokenIndex: 320, tokenId: "0xb113d34e351cf195733c98442530c099", hyperevmContract: null, markets: ["@194/USDC"] },
  { symbol: "UXPL", name: "Unit Plasma", sourceChain: "Plasma", tokenIndex: 343, tokenId: "0x2c54c60600e1d786b2dfc139a38a5a99", hyperevmContract: "0x33af3c2540ba72054e044efe504867b39ae421f5", markets: ["@210/USDC", "@233/USDH"] },
  { symbol: "UMON", name: "Unit Monad", sourceChain: "Monad", tokenIndex: 383, tokenId: "0x58dae745c8c5fed4012f35ef39829c2d", hyperevmContract: null, markets: ["@243/USDC"] },
  { symbol: "UZEC", name: "Unit Zcash", sourceChain: "Zcash", tokenIndex: 419, tokenId: "0x1c994ad3381d31c86c8c2d74ed89a365", hyperevmContract: null, markets: ["@272/USDC"] },
  { symbol: "UVIRT", name: "Unit Virtual", sourceChain: "Base/Virtuals", tokenIndex: 443, tokenId: "0x85b8124314ae77b78b4b6f20ecd93149", hyperevmContract: null, markets: [] },
  { symbol: "UAVAX", name: "Unit Avalanche", sourceChain: "Avalanche", tokenIndex: 451, tokenId: "0x730fc3855fb77d2aa5a19dd7891dbe80", hyperevmContract: null, markets: [] },
];

const STATIC_SOURCES = {
  publicUrls: {
    defillama: "https://defillama.com/protocol/unit",
    websiteDeposit: "https://hyperunit.xyz/deposit",
    app: "https://app.hyperunit.xyz/",
    docs: "https://docs.hyperunit.xyz/",
    explorer: "https://explorer.hyperunit.xyz/",
    hyperliquidInfoDocs: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint",
  },
  defillamaMetadata: {
    name: "Unit",
    slug: "unit",
    category: "Bridge",
    chains: ["Bitcoin", "Ethereum", "Solana", "Plasma", "Monad"],
    audits: 0,
    github: null,
    approximateTvlUsd: 482_000_000,
  },
  publicArchitectureNotes: [
    "Guardian Network with initial guardians Unit, Hyperliquid Labs, and Infinite Field.",
    "2-of-3 MPC/TSS signing model, chain services for deposit/finality tracking, flow manager sequencing, t-of-n consensus quorum, wallet manager threshold signatures, and circuit breakers are documented.",
    "Public docs do not resolve proof format, source/destination domain binding, chainId binding, nonce/replay handling, recipient/amount/token binding, finality depths, BTC SPV-vs-indexer model, or mint/burn/custody invariants.",
  ],
};

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function assertAllowedWrite(file) {
  const r = rel(path.resolve(file));
  if (!ALLOWED_WRITES.has(r)) throw new Error(`Refusing to write outside Unit step-1 ownership: ${r}`);
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
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(3)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
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

function evmContractAddress(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.address === "string") return value.address;
  return null;
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
    info.scope = json.scope && typeof json.scope === "string" ? json.scope : (json.scope && json.scope.topNUniverse) || null;
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
      "forkProofRows", "bridgeTokens", "lendingConsumers", "topLiquidityUsd", "concreteMismatchRows",
      "materialMismatchRows", "protocolsRanked", "newTargetCandidates", "rpcBlockedCandidates", "nonEvmCandidates",
    ]);
    return { info, json };
  } catch (err) {
    info.present = fs.existsSync(file);
    info.error = err && err.message ? err.message : String(err);
    return { info, json: null };
  }
}

function getByPath(obj, pathKeys) {
  let cur = obj;
  for (const key of pathKeys) {
    if (cur == null) return null;
    cur = cur[key];
  }
  return cur == null ? null : cur;
}

function findRowsBySymbol(json, symbol) {
  const rows = [];
  const arrays = [json && json.rows, json && json.topRows, json && json.routeProbeRows].filter(Array.isArray);
  for (const arr of arrays) {
    for (const row of arr) {
      const values = [
        row.symbol,
        row.token,
        getByPath(row, ["token", "name"]),
        getByPath(row, ["token", "symbol"]),
        getByPath(row, ["baseToken", "symbol"]),
        getByPath(row, ["quoteToken", "symbol"]),
      ].map((v) => String(v || "").toUpperCase());
      const identity = resolveCanonicalAsset(row);
      if (identity.ok && identity.canonical.symbol === symbol.toUpperCase() && values.includes(symbol.toUpperCase())) rows.push(row);
    }
  }
  return rows;
}

function extractDepthMetric(depthJson, symbol) {
  const row = findRowsBySymbol(depthJson, symbol)[0];
  if (!row) return null;
  const routeMetrics = deriveAssetRouteMetrics(row);
  return {
    found: Boolean(row.found),
    candidateClass: row.candidateClass || null,
    joinCount: getByPath(row, ["consumer", "joinCount"]),
    maxDexLiquidityUsd: round(getByPath(row, ["consumer", "maxDexLiquidityUsd"]), 2),
    maxYieldTvlUsd: round(getByPath(row, ["consumer", "maxYieldTvlUsd"]), 2),
    maxBorrowCashUsd: round(getByPath(row, ["consumer", "maxBorrowCashUsd"]), 2),
    dexLiquidityUsd: round(getByPath(row, ["dex", "liquidityUsd"]), 2),
    directUsdcMarket: getByPath(row, ["hyperCoreMarket", "name"]),
    exactDexQuote: Boolean(getByPath(row, ["dex", "exactDexQuote"])),
    multiHopExactRoutes: Array.isArray(row.routes) ? row.routes.filter((r) => getByPath(r, ["dex", "multiHopExact"])).length : 0,
    bestExactNetUsd: round(routeMetrics.bestExactNetUsd, 4),
    bestEstimatedNetUsd: round(routeMetrics.bestEstimatedNetUsd, 4),
    exactRouteCount: routeMetrics.exactRouteCount,
    estimatedRouteCount: routeMetrics.estimatedRouteCount,
    structuralErrors: routeMetrics.structuralErrors,
    routePositive: Array.isArray(row.routes) ? row.routes.some((r) => routeIsExact(row, r) && r.routePositive === true && r.netUsd > 0) : false,
    blockers: Array.isArray(row.blockers) ? row.blockers.slice(0, 4) : [],
  };
}

function extractInvariantMetric(invariantJson, symbol) {
  const row = findRowsBySymbol(invariantJson, symbol)[0];
  if (!row) return null;
  const supplySanity = deriveSupplySanity(row);
  return {
    index: getByPath(row, ["token", "index"]),
    evmContract: getByPath(row, ["token", "evmContract"]),
    codePresent: getByPath(row, ["evm", "codePresent"]),
    proxyLike: Boolean(getByPath(row, ["evm", "eip1967", "implementation"]) || getByPath(row, ["evm", "eip1967", "admin"])),
    supplySanity,
    systemBalanceExceedsSupply: supplySanity.systemBalanceExceedsSupply,
    watchCandidate: Boolean(row.watchCandidate),
    reviewCandidate: Boolean(row.reviewCandidate),
    routePositive: Boolean(row.routePositive),
    criticalFlags: Array.isArray(row.criticalFlags) ? row.criticalFlags : [],
    flags: Array.isArray(row.flags) ? row.flags.slice(0, 5) : [],
  };
}

function extractConsumerMetric(consumerJson, symbol) {
  const top = (consumerJson && consumerJson.summary && consumerJson.summary.diagnostics && consumerJson.summary.diagnostics.topResearchTokens || [])
    .find((row) => String(row.token || "").toUpperCase() === symbol.toUpperCase());
  const direct = findRowsBySymbol(consumerJson, symbol).find((row) => row.metrics || row.consumer || row.consumerType);
  const metrics = direct && direct.metrics ? direct.metrics : {};
  return top || direct ? {
    joinedLocally: true,
    score: top ? top.score : direct.score || null,
    joinCount: metrics.joinCount ?? null,
    maxDexLiquidityUsd: round(top ? top.maxDexLiquidityUsd : metrics.maxDexLiquidityUsd, 2),
    maxYieldTvlUsd: round(top ? top.maxYieldTvlUsd : metrics.maxYieldTvlUsd, 2),
    maxBorrowCashUsd: round(top ? top.maxBorrowCashUsd : metrics.maxBorrowCashUsd, 2),
    maxAbsEdgeBps: round(top ? top.maxAbsEdgeBps : metrics.maxAbsEdgeBps, 2),
    routePositive: false,
  } : null;
}

async function fetchHyperliquidSpotMeta() {
  return {
    attempted: false,
    ok: false,
    status: null,
    elapsedMs: null,
    tokenCount: 0,
    marketCount: 0,
    matchedUnitAssetCount: 0,
    matchedUnitAssets: [],
    error: "disabled-by-local-only-integrity-checkpoint",
  };
}

function buildAssetRows(artifacts) {
  const invariants = artifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"]?.json;
  const consumers = artifacts["reports/raw/fast/hyperliquid-linked-token-consumers.json"]?.json;
  const depth = artifacts["reports/raw/fast/hyperliquid-core-dex-depth-routes.json"]?.json;
  return UNIT_ASSET_SEEDS.map((seed) => {
    const invariantMetric = extractInvariantMetric(invariants, seed.symbol);
    const consumerMetric = extractConsumerMetric(consumers, seed.symbol);
    const depthMetric = extractDepthMetric(depth, seed.symbol);
    const bestExactNetUsd = depthMetric?.bestExactNetUsd ?? null;
    return {
      symbol: seed.symbol,
      name: seed.name,
      sourceChain: seed.sourceChain,
      tokenIndex: seed.tokenIndex,
      tokenId: seed.tokenId,
      hyperevmContract: seed.hyperevmContract,
      markets: seed.markets,
      identitySource: "canonical-local-registry",
      localInvariant: invariantMetric,
      localConsumer: consumerMetric,
      localExactDepth: depthMetric,
      summarizedMetrics: {
        hasHyperEvmContract: Boolean(seed.hyperevmContract),
        hasPublicMarket: seed.markets.length > 0,
        maxDexLiquidityUsd: round(depthMetric?.maxDexLiquidityUsd ?? consumerMetric?.maxDexLiquidityUsd, 2),
        maxBorrowCashUsd: round(depthMetric?.maxBorrowCashUsd ?? consumerMetric?.maxBorrowCashUsd, 2),
        bestExactNetUsd: round(bestExactNetUsd, 4),
        bestEstimatedNetUsd: round(depthMetric?.bestEstimatedNetUsd, 4),
        routePositive: Boolean(depthMetric?.routePositive),
      },
      step1Status: depthMetric?.routePositive
        ? "positive-exact-route-candidate"
        : (bestExactNetUsd != null ? "watch-exact-route-not-positive" : (depthMetric?.bestEstimatedNetUsd != null ? "watch-estimated-route-only" : "incomplete-no-valid-exact-route")),
    };
  });
}

function buildProofBindingChecklist() {
  return [
    { item: "Public proof format / verifier path", status: "unresolved", routeImpact: "Cannot validate forged deposit/replay surface without message/proof schema." },
    { item: "Source domain / chainId binding", status: "unresolved", routeImpact: "Cross-chain replay remains an audit question, not a proven issue." },
    { item: "Destination domain / HyperCore-vs-HyperEVM binding", status: "unresolved", routeImpact: "Linked-token mint accounting cannot be route-positive without destination binding proof." },
    { item: "Nonce and replay protection", status: "unresolved", routeImpact: "No replayable message or duplicate mint path observed." },
    { item: "Recipient binding", status: "unresolved", routeImpact: "No proof that recipient can be swapped or confused." },
    { item: "Token and amount binding", status: "unresolved", routeImpact: "No proof that token/amount can be substituted." },
    { item: "Finality depth / reorg handling", status: "docs-only", routeImpact: "Docs say chain services track finality, but exact depths are not public in this pass." },
    { item: "Guardian quorum / MPC/TSS", status: "docs-only-control", routeImpact: "2-of-3 trusted guardian architecture is documented; no key compromise or signing bypass evidence." },
    { item: "Circuit breakers / sequencing", status: "docs-only-control", routeImpact: "Controls are described but not enough to prove or disprove a deployed bypass." },
  ];
}

function buildCustodyChecklist(invariantSummary) {
  return [
    { item: "Custody wallet addresses per source chain", status: "unresolved", notes: "Public docs/app context does not expose a complete authoritative custody map in this step." },
    { item: "BTC SPV vs indexer/trusted-observer model", status: "unresolved", notes: "No public proof format or SPV verifier was resolved." },
    { item: "Local ERC20 supply sanity", status: "partial-local-context", notes: "Raw integer balances are compared with BigInt where present. systemBalance<=totalSupply is only a local ERC20 sanity check and is non-probative for native reserve/liability backing." },
    { item: "Unit-specific backing-vs-supply reconciliation", status: "not-proven", notes: "No source-chain custody balances were joined to Unit wrapped supply in this step." },
    { item: "Consumer accepted-value mismatch", status: "not-proven", notes: "Consumer joins exist, but no Unit acquisition or minting anomaly creates accepted-value profit." },
    { item: "Prior local invariant source status", status: "context-only", notes: `systemBalanceExceedsSupply=${invariantSummary?.systemBalanceExceedsSupply ?? "unknown"}; operational route status is derived separately from canonical exact economics.` },
  ];
}

function buildConsumerJoinSummary(artifacts, assetRows) {
  const consumers = artifacts["reports/raw/fast/hyperliquid-linked-token-consumers.json"]?.info?.summary || {};
  const lendingJoin = artifacts["reports/raw/fast/bridge-lending-collateral-join.json"]?.info?.summary || {};
  const joinedAssets = assetRows.filter((row) => row.localConsumer || row.localExactDepth?.joinCount).map((row) => ({
    symbol: row.symbol,
    joinCount: row.localExactDepth?.joinCount ?? row.localConsumer?.joinCount ?? null,
    maxDexLiquidityUsd: row.summarizedMetrics.maxDexLiquidityUsd,
    maxBorrowCashUsd: row.summarizedMetrics.maxBorrowCashUsd,
    routePositive: Boolean(row.summarizedMetrics.routePositive),
  }));
  return {
    hyperliquidLinkedTokenConsumers: consumers,
    bridgeLendingCollateralJoinContext: lendingJoin,
    unitJoinedAssets: joinedAssets,
    conclusion: "Unit assets have market/DEX/yield/consumer context, but these joins remain non-probative for producer-side proof; canonical exact economics is derived separately.",
    routePositive: 0,
  };
}

function buildEconomicsSummary(artifacts, assetRows, routeSummary) {
  const depthSummary = artifacts["reports/raw/fast/hyperliquid-core-dex-depth-routes.json"]?.info?.summary?.globalSourceContextNotUnitSummary || {};
  const byAsset = assetRows
    .filter((row) => row.summarizedMetrics.bestExactNetUsd != null || row.summarizedMetrics.maxDexLiquidityUsd != null)
    .map((row) => ({
      symbol: row.symbol,
      maxDexLiquidityUsd: row.summarizedMetrics.maxDexLiquidityUsd,
      maxBorrowCashUsd: row.summarizedMetrics.maxBorrowCashUsd,
      bestExactNetUsd: row.summarizedMetrics.bestExactNetUsd,
      bestEstimatedNetUsd: row.summarizedMetrics.bestEstimatedNetUsd,
      routePositive: row.summarizedMetrics.routePositive ? 1 : 0,
    }));
  return {
    globalDepthSourceContextNotUnitSummary: depthSummary,
    byAsset,
    bestExactNetUsd: routeSummary.bestExactUnitRoute?.netUsd ?? null,
    bestEstimatedNetUsd: routeSummary.bestEstimatedUnitRoute?.netUsd ?? null,
    bestEstimatedSymbol: routeSummary.bestEstimatedUnitRoute?.symbol ?? null,
    routeEvidenceStatus: routeSummary.routeEvidenceStatus,
    routePositiveOperational: routeSummary.routePositiveOperational,
    routePositive: routeSummary.routePositiveOperational,
    executableNow: 0,
    signedActionJustified: false,
    conclusion: "Canonical Unit exact and estimated routes are separated. Stale or incomplete economics remain context-only and cannot establish a clean negative.",
  };
}

function renderReport(raw) {
  const lines = [];
  lines.push("# Unit / Hyperunit Read-Only Discovery Triage");
  lines.push("");
  lines.push(`Signal: ${raw.operationalOutput.signalLabel} — auditClassification=${raw.auditClassification}, routeEvidenceStatus=${raw.routeEvidenceStatus}, routePositiveOperational=${raw.routePositiveOperational}, executableNow=0, signedActionJustified=false.`);
  lines.push("");
  lines.push("## Scope and Safety");
  lines.push("");
  lines.push(`- Scanner: \`${raw.scanner}\`, generated \`${raw.generatedAt}\`.`);
  lines.push("- Step 1 only: Unit/Hyperunit deterministic local artifact reduction. Public HTTP is disabled by this local-only checkpoint.");
  lines.push("- No endpoint inventories, env files, keys, RPC/GraphQL inventories, calldata execution, fork transactions, signed actions, wallets, exploit execution, aggregate gates, or executor work.");
  lines.push("- Network metadata lookup was disabled; identity rows come from the canonical local registry and are validated against local artifacts.");
  lines.push(`- Evidence complete=${raw.evidenceComplete}; closure eligible=${raw.closureEligible}; market freshness policy=${raw.freshnessPolicy.marketEconomics.id}.`);
  lines.push("- Static facts retain original observation timestamps and do not become fresh merely because this reducer reran.");
  lines.push("");
  lines.push("## Public Unit Context");
  lines.push("");
  lines.push("- DeFiLlama metadata: Unit / `unit`, Bridge, about `$482M` TVL context, chains Bitcoin/Ethereum/Solana/Plasma/Monad, audits=0, github=null.");
  lines.push("- Public architecture docs describe a Guardian Network, initial guardians Unit / Hyperliquid Labs / Infinite Field, 2-of-3 MPC/TSS, chain services, flow manager sequencing, consensus quorum, wallet manager threshold signatures, and circuit breakers.");
  lines.push("- Missing for route proof: public proof format, domain/chainId/nonce/recipient/amount/token binding, replay handling, finality depths, source-chain custody map, and mint/burn accounting invariants.");
  lines.push("");
  lines.push("## Unit Asset Rows");
  lines.push("");
  lines.push("| Asset | Source | Token index | HyperEVM contract | Markets | Max DEX liq | Max borrow cash | Best exact net | Best estimated net | Status |");
  lines.push("|---|---|---:|---|---|---:|---:|---:|---:|---|");
  for (const row of raw.unitAssetRows) {
    lines.push(`| ${md(row.symbol)} | ${md(row.sourceChain)} | ${row.tokenIndex ?? "n/a"} | ${md(row.hyperevmContract || "none listed")} | ${md(row.markets.join(", ") || "none listed")} | ${fmtUsd(row.summarizedMetrics.maxDexLiquidityUsd)} | ${fmtUsd(row.summarizedMetrics.maxBorrowCashUsd)} | ${fmtUsd(row.summarizedMetrics.bestExactNetUsd)} | ${fmtUsd(row.summarizedMetrics.bestEstimatedNetUsd)} | ${md(row.step1Status)} |`);
  }
  lines.push("");
  lines.push("## Existing Local Joins and Economics");
  lines.push("");
  lines.push(`- Linked-token invariant source context: scanned=${raw.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].summary?.linkedTokensScanned ?? "n/a"}, systemBalanceExceedsSupply=${raw.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].summary?.systemBalanceExceedsSupply ?? "n/a"}, sourceArtifactRoutePositive=${raw.sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].summary?.routePositive ?? "n/a"}.`);
  lines.push(`- Linked-token consumer source context: joinedRows=${raw.consumerJoinSummary.hyperliquidLinkedTokenConsumers.joinedRows ?? "n/a"}, consumerJoins=${raw.consumerJoinSummary.hyperliquidLinkedTokenConsumers.consumerJoins ?? "n/a"}, hyperlendJoins=${raw.consumerJoinSummary.hyperliquidLinkedTokenConsumers.hyperlendJoins ?? "n/a"}, sourceArtifactRoutePositive=${raw.consumerJoinSummary.hyperliquidLinkedTokenConsumers.routePositive ?? "n/a"}.`);
  lines.push(`- Canonical Unit routes: best exact=${raw.economicsSummary.bestExactNetUsd ?? "n/a"} (${raw.routeSummary.bestExactUnitRoute?.symbol ?? "n/a"}); best estimated=${raw.economicsSummary.bestEstimatedNetUsd ?? "n/a"} (${raw.economicsSummary.bestEstimatedSymbol ?? "n/a"}); evidence=${raw.routeEvidenceStatus}.`);
  lines.push("- UPUMP-like non-exact rows remain estimated and cannot displace the exact Unit best or promote an operational route.");
  lines.push(`- ${raw.operationalOutput.narrative}`);
  lines.push("");
  lines.push("## Proof Binding Checklist");
  lines.push("");
  lines.push("| Item | Status | Route impact |");
  lines.push("|---|---|---|");
  for (const item of raw.proofBindingChecklist) lines.push(`| ${md(item.item)} | ${md(item.status)} | ${md(item.routeImpact)} |`);
  lines.push("");
  lines.push("## Custody / Backing Checklist");
  lines.push("");
  lines.push("| Item | Status | Notes |");
  lines.push("|---|---|---|");
  for (const item of raw.custodyBackingChecklist) lines.push(`| ${md(item.item)} | ${md(item.status)} | ${md(item.notes)} |`);
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
  lines.push("No aggregate gate promotion, fork, executor, signed action, or transaction work is justified. Operational promotion remains fail-closed while economics is stale or mandatory domains are unknown.");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const generatedAt = new Date().toISOString();
  const loaded = loadArtifactManifest(WORKSPACE, SOURCE_ARTIFACT_SPECS, new Date(generatedAt));
  const artifacts = loaded.artifacts;
  const sourceArtifacts = Object.fromEntries(loaded.manifest.map((entry) => [entry.path, entry]));

  const unitAssetRows = buildAssetRows(artifacts);
  const invariantSummary = sourceArtifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].summary || {};
  const proofBindingChecklist = buildProofBindingChecklist();
  const custodyBackingChecklist = buildCustodyChecklist(invariantSummary);
  const consumerJoinSummary = buildConsumerJoinSummary(artifacts, unitAssetRows);
  const depthPath = "reports/raw/fast/hyperliquid-core-dex-depth-routes.json";
  const routeSummary = deriveUnitRouteSummary(artifacts[depthPath].json, sourceArtifacts[depthPath]);
  const canonicalProxyCoverage = validateObservedProxyCoverage(artifacts["reports/raw/fast/hyperliquid-linked-token-invariants.json"].json);
  const economicsSummary = buildEconomicsSummary(artifacts, unitAssetRows, routeSummary);
  const checkpoint = buildIntegrityCheckpoint({
    manifest: loaded.manifest,
    routeSummary,
    coverage: canonicalProxyCoverage,
    mandatoryDomains: {
      economics: routeSummary.routeEvidenceStatus,
      proofBinding: "unknown",
      custodyBacking: "unknown",
      sourceSemantics: "unknown",
    },
  });

  const staticBlockers = [
    "No Unit proof/domain/nonce/recipient/amount/token-binding/custody/accounting bypass is proven.",
    "Existing HyperCore/HyperEVM exact depth routes are net-negative after conservative costs.",
    "Consumer joins are context-only without a producer-side acquisition or unbacked-mint anomaly.",
    "No source-chain custody-vs-wrapped-supply reconciliation is available in this step.",
    "No local fork/static-call proof of positive value delta exists; routePositive remains fail-closed at 0.",
  ];
  if (!canonicalProxyCoverage.complete) staticBlockers.push("Canonical six-proxy coverage validation is incomplete or mismatched.");
  const operationalOutput = buildOperationalOutputSummary(routeSummary, staticBlockers);

  const requiredForRoutePositive = [
    "Authoritative Unit deposit/mint/burn/proof message format and verifier path with source/destination domain, nonce, token, amount, recipient, and finality binding.",
    "Current source-chain custody balances and Unit wrapped supply joined without relying on private endpoints or keys.",
    "A permissionless producer-side flaw that allows acquisition/mint below accepted consumer value.",
    "Exact HyperCore/HyperEVM/lending/DEX route economics positive after LTV, liquidity, slippage, fees, delay, and gas.",
    "Local read-only/fork/static-call proof artifact demonstrating positive value delta before any aggregate gate or executor consideration.",
  ];

  const raw = {
    generatedAt,
    scanner: SCANNER,
    scope: "Unit / Hyperunit step-1 local-only read-only discovery; deterministic local artifacts only; network disabled",
    safety: {
      readOnlyResearch: true,
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
      publicHttpRead: false,
      routePositive: checkpoint.routePositiveOperational > 0,
      routePositiveOperational: checkpoint.routePositiveOperational,
      executableNow: false,
      signedActionJustified: false,
      aggregateGatePromoted: false,
    },
    freshnessPolicy: FRESHNESS_POLICY,
    artifactManifest: loaded.manifest,
    canonicalAssetRegistry: CANONICAL_UNIT_ASSETS,
    canonicalIdentityNotes: [
      { pair: "UMON-vs-SPXS", status: "distinct-strong-identifiers-not-aliased", note: "UMON tokenIndex/tokenId and SPXS tokenId identify different assets; symbol/display matching is prohibited." },
      { pair: "XPL-vs-UXPL", status: "explicit-alias-same-canonical-asset", tokenId: "0x2c54c60600e1d786b2dfc139a38a5a99", note: "XPL and UXPL are aliases only when the strong tokenId/index identity agrees." },
    ],
    staticSources: STATIC_SOURCES,
    networkMetadataLookup: { attempted: false, status: "disabled-local-only" },
    sourceArtifacts,
    unitAssetRows,
    proofBindingChecklist,
    custodyBackingChecklist,
    consumerJoinSummary,
    economicsSummary,
    routeSummary,
    canonicalProxyCoverage,
    operationalOutput,
    ...checkpoint,
    blockers: operationalOutput.blockers,
    requiredForRoutePositive,
    nextReadOnlyStep: "Resolve Unit-specific public proof/custody/accounting documentation and source-chain backing data, then join it to existing UBTC/UETH/USOL consumer/economics artifacts without changing route gates.",
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
  console.log(`unitAssets=${unitAssetRows.length} routeEvidenceStatus=${raw.routeEvidenceStatus} bestExactUnitNet=${raw.routeSummary.bestExactUnitRoute?.netUsd ?? "n/a"} bestEstimatedUnitNet=${raw.routeSummary.bestEstimatedUnitRoute?.netUsd ?? "n/a"} routePositiveOperational=${raw.routePositiveOperational} executableNow=0 signedActionJustified=false`);
}

main().catch((err) => {
  console.error(`scan-unit-readonly-discovery failed: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
