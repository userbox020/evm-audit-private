"use strict";

const fs = require("fs");
const path = require("path");

const HOUR_MS = 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const FRESHNESS_POLICY = Object.freeze({
  marketEconomics: {
    id: "market-economics-24h",
    maxAgeMs: 24 * HOUR_MS,
    description: "Market, depth, liquidity, and route economics must be generated within 24 hours of the reducer run.",
  },
  dynamicSnapshot: {
    id: "dynamic-snapshot-24h",
    maxAgeMs: 24 * HOUR_MS,
    description: "Mutable balances, supplies, implementation slots, oracle ages, cash, liquidity, and TVL snapshots must be no older than 24 hours.",
  },
  static: {
    id: "static-observation-no-wall-clock-expiry",
    maxAgeMs: null,
    description: "Static source/build/identity facts do not become fresh when a reducer reruns; their original observation timestamp is preserved and no wall-clock expiry is inferred.",
  },
  derived: {
    id: "derived-inherits-input-status",
    maxAgeMs: null,
    description: "Derived Unit artifacts preserve the completeness and freshness status of their required inputs.",
  },
});

const CANONICAL_UNIT_ASSETS = Object.freeze([
  { key: "bitcoin:btc", symbol: "UBTC", aliases: ["UBTC"], sourceChain: "Bitcoin", asset: "BTC", tokenIndex: 197, tokenId: "0x8f254b963e8468305d409b33aa137c67", proxyAddress: "0x9fdbda0a5e284c32744d2f17ee5c74b284993463" },
  { key: "ethereum:eth", symbol: "UETH", aliases: ["UETH"], sourceChain: "Ethereum", asset: "ETH", tokenIndex: 221, tokenId: "0xe1edd30daaf5caac3fe63569e24748da", proxyAddress: "0xbe6727b535545c67d5caa73dea54865b92cf7907" },
  { key: "solana:sol", symbol: "USOL", aliases: ["USOL"], sourceChain: "Solana", asset: "SOL", tokenIndex: 254, tokenId: "0x49b67c39f5566535de22b29b0e51e685", proxyAddress: "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29" },
  { key: "solana:fartcoin", symbol: "UFART", aliases: ["UFART"], sourceChain: "Solana", asset: "FARTCOIN", tokenIndex: 269, tokenId: "0x7650808198966e4285687d3deb556ccc", proxyAddress: "0x3b4575e689ded21caad31d64c4df1f10f3b2cedf" },
  { key: "solana:pump", symbol: "UPUMP", aliases: ["UPUMP"], sourceChain: "Solana", asset: "PUMP", tokenIndex: 299, tokenId: "0x544e60f98a36d7b22c0fb5824b84f795", proxyAddress: "0x27ec642013bcb3d80ca3706599d3cda04f6f4452" },
  { key: "solana:bonk", symbol: "UBONK", aliases: ["UBONK"], sourceChain: "Solana", asset: "BONK", tokenIndex: 320, tokenId: "0xb113d34e351cf195733c98442530c099", proxyAddress: null },
  { key: "plasma:xpl", symbol: "UXPL", aliases: ["UXPL", "XPL"], sourceChain: "Plasma", asset: "XPL", tokenIndex: 343, tokenId: "0x2c54c60600e1d786b2dfc139a38a5a99", proxyAddress: "0x33af3c2540ba72054e044efe504867b39ae421f5" },
  { key: "monad:mon", symbol: "UMON", aliases: ["UMON"], sourceChain: "Monad", asset: "MON", tokenIndex: 383, tokenId: "0x58dae745c8c5fed4012f35ef39829c2d", proxyAddress: null },
  { key: "solana:spxs", symbol: "UUUSPX", aliases: ["UUUSPX", "SPXS"], sourceChain: "Solana", asset: "SPXS", tokenIndex: null, tokenId: "0x2ff71b802a6788a052c7f1a58ec863af", proxyAddress: null },
  { key: "zcash:zec", symbol: "UZEC", aliases: ["UZEC"], sourceChain: "Zcash", asset: "ZEC", tokenIndex: 419, tokenId: "0x1c994ad3381d31c86c8c2d74ed89a365", proxyAddress: null },
  { key: "base:virtual", symbol: "UVIRT", aliases: ["UVIRT"], sourceChain: "Base", asset: "VIRTUAL", tokenIndex: 443, tokenId: "0x85b8124314ae77b78b4b6f20ecd93149", proxyAddress: null },
  { key: "avalanche:avax", symbol: "UAVAX", aliases: ["UAVAX"], sourceChain: "Avalanche", asset: "AVAX", tokenIndex: 451, tokenId: "0x730fc3855fb77d2aa5a19dd7891dbe80", proxyAddress: null },
]);

const OBSERVED_HYPEREVM_PROXY_SYMBOLS = Object.freeze(["UBTC", "UETH", "USOL", "UFART", "UPUMP", "UXPL"]);

function normalized(value) {
  return value == null ? null : String(value).toLowerCase();
}

function valueAt(object, dottedPath) {
  return dottedPath.split(".").reduce((value, key) => value == null ? undefined : value[key], object);
}

function schemaCompatible(json, spec) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  if (!(spec.requiredPaths || []).every((requiredPath) => valueAt(json, requiredPath) !== undefined)) return false;
  for (const [field, type] of Object.entries(spec.requiredTypes || {})) {
    const value = valueAt(json, field);
    if (type === "array" ? !Array.isArray(value) : typeof value !== type) return false;
  }
  return typeof spec.validate !== "function" || spec.validate(json) === true;
}

function loadArtifact(workspace, spec, now = new Date()) {
  const absolutePath = path.join(workspace, spec.path);
  const policy = FRESHNESS_POLICY[spec.evidenceClass || "static"];
  const info = {
    path: spec.path.replace(/\\/g, "/"),
    required: spec.required !== false,
    evidenceClass: spec.evidenceClass || "static",
    loadStatus: "missing",
    parseStatus: "not-attempted",
    schemaStatus: "not-evaluated",
    generatedAt: null,
    generatedAtStatus: "missing",
    freshnessPolicy: policy.id,
    freshnessStatus: spec.evidenceClass === "derived" ? "unknown" : (policy.maxAgeMs == null ? "static-not-expiring" : "unknown"),
    ageMs: null,
    evidenceUsable: false,
    summary: null,
    error: null,
  };
  if (!fs.existsSync(absolutePath)) return { info, json: null };
  info.loadStatus = "loaded";
  try {
    const json = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    info.parseStatus = "ok";
    info.schemaStatus = schemaCompatible(json, spec) ? "compatible" : "incompatible";
    info.summary = json.summary && typeof json.summary === "object"
      ? (spec.evidenceClass === "marketEconomics" ? { globalSourceContextNotUnitSummary: json.summary } : json.summary)
      : null;
    const generatedAt = json.generatedAt || json.scannedAt || null;
    if (generatedAt) {
      const generatedMs = Date.parse(generatedAt);
      info.generatedAt = generatedAt;
      if (Number.isFinite(generatedMs)) {
        info.generatedAtStatus = "available";
        const signedAgeMs = now.getTime() - generatedMs;
        info.ageMs = signedAgeMs;
        if (signedAgeMs < -CLOCK_SKEW_MS) info.freshnessStatus = "future";
        else if (policy.maxAgeMs != null) info.freshnessStatus = signedAgeMs <= policy.maxAgeMs ? "fresh" : "stale";
      } else {
        info.generatedAtStatus = "malformed";
        info.freshnessStatus = "unknown";
      }
    } else if (policy.maxAgeMs != null) {
      info.freshnessStatus = "unknown";
    }
    if (spec.evidenceClass === "derived" && info.freshnessStatus !== "future") {
      info.freshnessStatus = json.evidenceComplete === true ? "inherited-complete" : "inherited-incomplete";
    }
    info.evidenceUsable = info.parseStatus === "ok"
      && info.schemaStatus === "compatible"
      && info.generatedAtStatus !== "malformed"
      && info.freshnessStatus !== "future"
      && (policy.maxAgeMs == null || info.freshnessStatus === "fresh")
      && (spec.evidenceClass !== "derived" || info.freshnessStatus === "inherited-complete");
    return { info, json };
  } catch (error) {
    info.parseStatus = "malformed";
    info.error = error && error.message ? error.message : String(error);
    return { info, json: null };
  }
}

function loadArtifactManifest(workspace, specs, now = new Date()) {
  const artifacts = {};
  const manifest = [];
  for (const spec of specs) {
    const loaded = loadArtifact(workspace, spec, now);
    artifacts[spec.path] = loaded;
    manifest.push(loaded.info);
  }
  return { artifacts, manifest };
}

function requiredEvidenceComplete(manifest) {
  return manifest.filter((entry) => entry.required).every((entry) => entry.evidenceUsable);
}

function resolveCanonicalAsset(row, registry = CANONICAL_UNIT_ASSETS) {
  const token = row && row.token && typeof row.token === "object" ? row.token : row || {};
  const supplied = {
    tokenIndex: token.index ?? row?.tokenIndex ?? null,
    tokenId: normalized(token.tokenId ?? row?.tokenId),
    proxyAddress: normalized(token.evmContract ?? row?.proxyAddress ?? row?.hyperevmContract),
    symbol: String(row?.symbol ?? token.name ?? "").toUpperCase() || null,
  };
  const strongMatches = [];
  for (const [field, value] of Object.entries(supplied)) {
    if (field === "symbol" || value == null) continue;
    const matches = registry.filter((asset) => normalized(field === "proxyAddress" ? asset.proxyAddress : asset[field]) === normalized(value));
    if (matches.length === 0) return { ok: false, status: "unknown-strong-identifier", field, supplied, canonical: null };
    if (matches.length > 1) return { ok: false, status: "ambiguous-strong-identifier", field, supplied, canonical: null };
    strongMatches.push({ field, asset: matches[0] });
  }
  const keys = new Set(strongMatches.map((match) => match.asset.key));
  if (keys.size > 1) return { ok: false, status: "canonical-identity-conflict", supplied, canonical: null };
  const canonical = strongMatches[0] && strongMatches[0].asset;
  if (!canonical) {
    const symbolMatches = registry.filter((asset) => asset.aliases.includes(supplied.symbol));
    return { ok: false, status: symbolMatches.length ? "symbol-only-identity-rejected" : "not-unit", supplied, canonical: null };
  }
  if (supplied.symbol && !canonical.aliases.includes(supplied.symbol)) {
    return { ok: false, status: "canonical-symbol-conflict", supplied, canonical };
  }
  return { ok: true, status: "canonical-strong-identity", supplied, canonical };
}

function unitAssociationForRejectedRow(identity, registry) {
  const supplied = identity?.supplied || {};
  const strongFields = [
    ["tokenIndex", "tokenIndex"],
    ["tokenId", "tokenId"],
    ["proxyAddress", "proxyAddress"],
  ];
  const associated = new Set();
  for (const [suppliedField, assetField] of strongFields) {
    if (supplied[suppliedField] == null) continue;
    for (const asset of registry) {
      if (normalized(asset[assetField]) === normalized(supplied[suppliedField])) associated.add(asset.key);
    }
  }
  for (const asset of registry) {
    if (supplied.symbol && asset.aliases.includes(supplied.symbol)) associated.add(asset.key);
  }
  return [...associated];
}

function positiveFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateRouteStructure(row, route) {
  const errors = [];
  if (!route || typeof route !== "object" || Array.isArray(route)) return ["route-not-object"];
  if (typeof route.netUsd !== "number" || !Number.isFinite(route.netUsd)) errors.push("netUsd-not-finite-number");
  if (!positiveFinite(route.sizeUsd)) errors.push("sizeUsd-not-positive-finite-number");
  if (!route.dex || typeof route.dex !== "object") errors.push("dex-not-object");
  else if (typeof route.dex.exactDexQuote !== "boolean") errors.push("route-exact-flag-not-boolean");
  if (typeof route.routePositive !== "boolean") errors.push("routePositive-not-boolean");
  if (route.core?.complete !== true) errors.push("core-not-complete");
  if (route.direction === "core-buy-evm-sell") {
    if (![route.core?.quoteSpent, route.core?.baseBought, route.core?.costWithFeeUsd].every(positiveFinite)) errors.push("core-buy-shape-invalid");
    if (!positiveFinite(route.dex?.usdOut)) errors.push("evm-sell-output-invalid");
  } else if (route.direction === "evm-buy-core-sell") {
    const required = [route.dex?.baseBought, route.core?.baseSold, route.core?.quoteOut, route.core?.outWithFeeUsd];
    if (route.dex?.exactDexQuote === true) required.push(route.dex?.amountIn);
    if (!required.every(positiveFinite)) errors.push("evm-buy-core-sell-shape-invalid");
  } else {
    errors.push("direction-invalid");
  }
  if (row?.dex?.exactDexQuote === true && route.dex?.exactDexQuote === true && !routeIsExact(row, route)) errors.push("exact-settlement-incomplete");
  if (row?.dex?.exactDexQuote === false && route.dex?.exactDexQuote === true) errors.push("row-route-exact-flag-conflict");
  return errors;
}

function validateUnitCandidateRow(row) {
  const errors = [];
  if (!row || typeof row !== "object" || Array.isArray(row)) return ["row-not-object"];
  if (!row.token || typeof row.token !== "object" || Array.isArray(row.token)) errors.push("token-not-object");
  if (row.token?.index != null && !Number.isInteger(row.token.index)) errors.push("token-index-not-integer");
  if (row.token?.tokenId != null && typeof row.token.tokenId !== "string") errors.push("tokenId-not-string");
  if (row.token?.evmContract != null && typeof row.token.evmContract !== "string") errors.push("evmContract-not-string");
  if (row.symbol != null && typeof row.symbol !== "string") errors.push("symbol-not-string");
  if (!row.dex || typeof row.dex !== "object" || typeof row.dex.exactDexQuote !== "boolean") errors.push("row-exact-flag-not-boolean");
  if (!Array.isArray(row.routes)) errors.push("routes-not-array");
  return errors;
}

function routeIsExact(row, route) {
  if (!row || !route || row.dex?.exactDexQuote !== true || route.dex?.exactDexQuote !== true) return false;
  if (!positiveFinite(route.sizeUsd) || route.core?.complete !== true) return false;
  if (route.direction === "core-buy-evm-sell") {
    if (![route.core.quoteSpent, route.core.baseBought, route.core.costWithFeeUsd, route.dex.usdOut].every(positiveFinite)) return false;
  } else if (route.direction === "evm-buy-core-sell") {
    if (![route.dex.amountIn, route.dex.baseBought, route.core.baseSold, route.core.quoteOut, route.core.outWithFeeUsd].every(positiveFinite)) return false;
  } else {
    return false;
  }
  const counterparty = route.dex.counterparty;
  if (!counterparty || typeof counterparty.usdLike !== "boolean") return false;
  if (counterparty.usdLike === false) {
    const settlement = route.direction === "core-buy-evm-sell" ? route.dex.unwind?.amountOut : route.dex.acquisition?.baseBought;
    return route.dex.multiHopExact === true && route.dex.finalCounterparty?.usdLike === true && positiveFinite(settlement);
  }
  return true;
}

function deriveAssetRouteMetrics(row) {
  const exact = [];
  const estimated = [];
  const structuralErrors = [];
  const rowErrors = validateUnitCandidateRow(row);
  if (rowErrors.length) {
    return { bestExactNetUsd: null, bestEstimatedNetUsd: null, exactRouteCount: 0, estimatedRouteCount: 0, structuralErrors: [{ scope: "row", errors: rowErrors }] };
  }
  for (const [routeIndex, route] of row.routes.entries()) {
    const errors = validateRouteStructure(row, route);
    if (errors.length) {
      structuralErrors.push({ scope: "route", routeIndex, errors });
      continue;
    }
    (routeIsExact(row, route) ? exact : estimated).push(route.netUsd);
  }
  exact.sort((a, b) => b - a);
  estimated.sort((a, b) => b - a);
  return {
    bestExactNetUsd: exact[0] ?? null,
    bestEstimatedNetUsd: estimated[0] ?? null,
    exactRouteCount: exact.length,
    estimatedRouteCount: estimated.length,
    structuralErrors,
  };
}

function deriveUnitRouteSummary(depthJson, depthManifestEntry, registry = CANONICAL_UNIT_ASSETS) {
  const exactRoutes = [];
  const estimatedRoutes = [];
  const identityFlags = [];
  const structuralFlags = [];
  for (const row of Array.isArray(depthJson?.rows) ? depthJson.rows : []) {
    const identity = resolveCanonicalAsset(row, registry);
    if (!identity.ok) {
      const associatedCanonicalKeys = unitAssociationForRejectedRow(identity, registry);
      if (associatedCanonicalKeys.length) identityFlags.push({
        symbol: identity.supplied?.symbol || null,
        status: identity.status,
        field: identity.field || null,
        associatedCanonicalKeys,
        supplied: identity.supplied,
      });
      continue;
    }
    const rowErrors = validateUnitCandidateRow(row);
    if (rowErrors.length) {
      structuralFlags.push({ canonicalKey: identity.canonical.key, symbol: identity.canonical.symbol, scope: "row", errors: rowErrors });
      continue;
    }
    for (const [routeIndex, route] of row.routes.entries()) {
      const routeErrors = validateRouteStructure(row, route);
      if (routeErrors.length) {
        structuralFlags.push({ canonicalKey: identity.canonical.key, symbol: identity.canonical.symbol, scope: "route", routeIndex, errors: routeErrors });
        continue;
      }
      const reduced = {
        canonicalKey: identity.canonical.key,
        symbol: identity.canonical.symbol,
        direction: route.direction || null,
        sizeUsd: route.sizeUsd ?? null,
        netUsd: route.netUsd,
        exact: routeIsExact(row, route),
        sourceRoutePositive: route.routePositive === true,
      };
      (reduced.exact ? exactRoutes : estimatedRoutes).push(reduced);
    }
  }
  const sortBest = (a, b) => b.netUsd - a.netUsd;
  exactRoutes.sort(sortBest);
  estimatedRoutes.sort(sortBest);
  const artifactUsable = Boolean(depthManifestEntry?.evidenceUsable);
  const qualifyingPositive = exactRoutes.filter((route) => route.netUsd > 0 && route.sourceRoutePositive);
  const integrityFlagCount = identityFlags.length + structuralFlags.length;
  const routePositiveOperational = artifactUsable && integrityFlagCount === 0 && qualifyingPositive.length ? qualifyingPositive.length : 0;
  let routeEvidenceStatus = "unknown";
  if (artifactUsable && integrityFlagCount === 0 && exactRoutes.length) {
    routeEvidenceStatus = qualifyingPositive.length ? "positive" : "negative";
  }
  return {
    sourceArtifact: depthManifestEntry?.path || null,
    sourceGeneratedAt: depthManifestEntry?.generatedAt || null,
    sourceFreshnessStatus: depthManifestEntry?.freshnessStatus || "unknown",
    canonicalRowsOnly: true,
    exactAndEstimatedSeparated: true,
    exactRouteCount: exactRoutes.length,
    estimatedRouteCount: estimatedRoutes.length,
    bestExactUnitRoute: exactRoutes[0] || null,
    bestEstimatedUnitRoute: estimatedRoutes[0] || null,
    identityFlags,
    structuralFlags,
    integrityFlagCount,
    qualifyingPositiveRoutes: artifactUsable && integrityFlagCount === 0 ? qualifyingPositive : [],
    routePositiveOperational,
    routeEvidenceStatus,
  };
}

function buildOperationalOutputSummary(routeSummary, staticBlockers = []) {
  const positive = routeSummary?.routeEvidenceStatus === "positive" && routeSummary.routePositiveOperational > 0;
  const economicsPattern = /net-negative|net negative|no exact positive|no exact-positive|exact economics remain|routepositive=0/i;
  const blockers = (staticBlockers || []).filter((blocker) => !positive || !economicsPattern.test(blocker));
  if (!positive) {
    blockers.push(routeSummary?.routeEvidenceStatus === "unknown"
      ? "Canonical Unit economics evidence is missing, stale, malformed, mismatched, or lacks a complete exact USD-settled route."
      : "No qualifying complete exact USD-settled positive Unit route exists in current evidence.");
  }
  return {
    signalLabel: "🟠 WATCH",
    statusLabel: positive ? "positive-exact-route-candidate" : (routeSummary?.routeEvidenceStatus === "negative" ? "negative-exact-route" : "incomplete-route-evidence"),
    routeTableValue: positive ? routeSummary.routePositiveOperational : 0,
    routePositiveCandidates: positive ? routeSummary.qualifyingPositiveRoutes : [],
    blockers: [...new Set(blockers)],
    narrative: positive
      ? `Fresh complete exact Unit economics produced ${routeSummary.routePositiveOperational} operational positive candidate(s).`
      : "Operational promotion remains fail-closed; economics evidence is not a fresh complete exact positive Unit route.",
  };
}

function buildStageOutputView(stageName, routeSummary, checkpoint, economicsRows = [], staticBlockers = []) {
  const operationalOutput = buildOperationalOutputSummary(routeSummary, staticBlockers);
  const positiveSymbols = new Set(operationalOutput.routePositiveCandidates.map((row) => row.symbol));
  const routeTableRows = economicsRows.map((row) => ({
    ...row,
    routePositive: positiveSymbols.has(row.symbol) ? 1 : (row.routePositive ? 1 : 0),
  }));
  return {
    stageName,
    operationalOutput,
    signal: `${operationalOutput.signalLabel} — auditClassification=${checkpoint.auditClassification}, routeEvidenceStatus=${checkpoint.routeEvidenceStatus}, routePositiveOperational=${checkpoint.routePositiveOperational}`,
    status: operationalOutput.statusLabel,
    routeTableRows,
    reportText: [
      operationalOutput.signalLabel,
      checkpoint.auditClassification,
      operationalOutput.statusLabel,
      operationalOutput.narrative,
      ...operationalOutput.blockers,
      ...routeTableRows.map((row) => `${row.symbol}|${row.routePositive}`),
    ].join("\n"),
  };
}

function deriveSupplySanity(row) {
  const totalSupplyRaw = row?.evm?.totalSupplyRaw;
  const systemBalanceRaw = row?.evm?.systemBalanceRaw;
  if (!/^\d+$/.test(String(totalSupplyRaw || "")) || !/^\d+$/.test(String(systemBalanceRaw || ""))) {
    return {
      status: "unknown-missing-raw-integer-evidence",
      systemBalanceExceedsSupply: null,
      arithmetic: "BigInt",
      probativeForNativeBacking: false,
    };
  }
  const exceeds = BigInt(systemBalanceRaw) > BigInt(totalSupplyRaw);
  return {
    status: exceeds ? "local-erc20-sanity-failed" : "local-erc20-sanity-passed",
    systemBalanceExceedsSupply: exceeds,
    arithmetic: "BigInt",
    totalSupplyRaw: String(totalSupplyRaw),
    systemBalanceRaw: String(systemBalanceRaw),
    interpretation: "Local ERC20 systemBalance<=totalSupply sanity check only; non-probative for native reserve/liability backing.",
    probativeForNativeBacking: false,
  };
}

function implementationCoverage(reviewedSymbols, observedSymbols = OBSERVED_HYPEREVM_PROXY_SYMBOLS) {
  const observed = [...new Set(observedSymbols.map((symbol) => String(symbol).toUpperCase()))];
  const reviewed = [...new Set((reviewedSymbols || []).map((symbol) => String(symbol).toUpperCase()))].filter((symbol) => observed.includes(symbol));
  const missing = observed.filter((symbol) => !reviewed.includes(symbol));
  return {
    observedProxyCount: observed.length,
    observedProxySymbols: observed,
    reviewedProxyCount: reviewed.length,
    reviewedProxySymbols: reviewed,
    missingProxySymbols: missing,
    complete: missing.length === 0,
    status: missing.length ? "incomplete-scope" : "complete-scope",
  };
}

function validateObservedProxyCoverage(invariantJson, registry = CANONICAL_UNIT_ASSETS) {
  const expected = registry.filter((asset) => OBSERVED_HYPEREVM_PROXY_SYMBOLS.includes(asset.symbol) && asset.proxyAddress);
  const observed = new Map();
  const mismatchFlags = [];
  for (const row of Array.isArray(invariantJson?.rows) ? invariantJson.rows : []) {
    const identity = resolveCanonicalAsset(row, registry);
    if (!identity.ok || !OBSERVED_HYPEREVM_PROXY_SYMBOLS.includes(identity.canonical.symbol)) continue;
    const address = normalized(row?.token?.evmContract ?? row?.proxyAddress ?? row?.hyperevmContract);
    if (address !== normalized(identity.canonical.proxyAddress)) {
      mismatchFlags.push({ symbol: identity.canonical.symbol, status: "proxy-address-mismatch", observed: address, expected: identity.canonical.proxyAddress });
      continue;
    }
    observed.set(identity.canonical.symbol, address);
  }
  for (const asset of expected) {
    if (!observed.has(asset.symbol)) mismatchFlags.push({ symbol: asset.symbol, status: "expected-proxy-not-observed", expected: asset.proxyAddress });
  }
  return {
    expectedProxySymbols: expected.map((asset) => asset.symbol),
    observedProxySymbols: [...observed.keys()],
    mismatchFlags,
    complete: mismatchFlags.length === 0 && observed.size === expected.length,
    status: mismatchFlags.length ? "incomplete-canonical-coverage" : "validated-canonical-coverage",
  };
}

function buildIntegrityCheckpoint({ manifest, routeSummary, mandatoryDomains, coverage = null }) {
  const domainEntries = Object.entries(mandatoryDomains || {});
  const domainsKnown = domainEntries.length > 0 && domainEntries.every(([, status]) => status === "positive" || status === "negative");
  const manifestComplete = requiredEvidenceComplete(manifest || []);
  const evidenceComplete = manifestComplete && domainsKnown && (!coverage || coverage.complete);
  const anyPositive = domainEntries.some(([, status]) => status === "positive") || routeSummary?.routeEvidenceStatus === "positive";
  const closureEligible = evidenceComplete && !anyPositive && routeSummary?.routeEvidenceStatus === "negative";
  return {
    routePositiveOperational: routeSummary?.routePositiveOperational || 0,
    routeEvidenceStatus: routeSummary?.routeEvidenceStatus || "unknown",
    evidenceComplete,
    closureEligible,
    auditClassification: anyPositive ? "POSITIVE/REVIEW" : (evidenceComplete ? "NEGATIVE/WATCH" : "INCOMPLETE/WATCH"),
    mandatoryDomains: Object.fromEntries(domainEntries),
  };
}

module.exports = {
  CANONICAL_UNIT_ASSETS,
  FRESHNESS_POLICY,
  OBSERVED_HYPEREVM_PROXY_SYMBOLS,
  buildIntegrityCheckpoint,
  buildOperationalOutputSummary,
  buildStageOutputView,
  deriveAssetRouteMetrics,
  deriveSupplySanity,
  deriveUnitRouteSummary,
  implementationCoverage,
  loadArtifact,
  loadArtifactManifest,
  requiredEvidenceComplete,
  resolveCanonicalAsset,
  routeIsExact,
  validateObservedProxyCoverage,
};
