#!/usr/bin/env node
// Read-only Aave V4 spoke borrower/liquidation mapper.
// RPC URLs are resolved in memory only and are never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { sanitizeError } = require("./shared-rpc");
const { buildAaveSourceCoverage, validateAaveSourceCoverageEnvelope, boundTopologyProvenanceFailure, validateV4TopologyAuthority, validateV4ExhaustiveEvidence, fullV4HistoryProven, validV4ObservationPin } = require("./aave-source-coverage");
const { openPinnedCollection, CollectionError } = require("./lib/aave-v4-pinned-collection");
const borrowerHistory = require("./lib/aave-v4-borrower-history");

const WORKSPACE = path.resolve(__dirname, "..");
const HUBS_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-hubs.json");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-spoke-borrowers.json");
const HISTORY_DIR = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-borrower-history");
const ETHEREUM_CHAIN_ID = 1;
const LOG_CHUNK_BLOCKS = Number(process.env.AAVE_V4_LOG_CHUNK_BLOCKS || "10000");
const MAX_USERS_PER_SPOKE = Number(process.env.AAVE_V4_MAX_USERS_PER_SPOKE || "20");
const MIN_SPOKE_OWED_USD = Number(process.env.AAVE_V4_MIN_SPOKE_OWED_USD || "10000");
const TOPOLOGY_MAX_AGE_MS = finitePositive(process.env.AAVE_V4_TOPOLOGY_MAX_AGE_MS, 10 * 60_000, 10 * 60_000);
const CHAINS_EXPECTED = 1;
const WAD = 10n ** 18n;
const COVERAGE_ERROR_CODES = new Set([
  "topology-generated-at-invalid", "topology-generated-at-future", "topology-stale",
  "topology-refresh-failed", "topology-refresh-incomplete", "topology-source-incomplete", "required-spoke-failed",
  "required-chain-set-mismatch", "required-chain-failed", "log-chunk-coverage-invalid",
  "log-chunk-coverage-empty", "log-chunk-failed", "log-query-failed", "borrower-truncated",
  "borrower-check-incomplete", "account-read-failed", "reserve-read-failed", "source-error",
  "bounded-window-incomplete", "spoke-filtered", "borrower-source-incomplete", "borrower-counts-invalid", "borrower-cap-invalid",
  "history-backfill-pending", "history-query-failed", "borrower-pagination-incomplete", "borrower-history-debt-unaccounted",
]);

function finitePositive(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

const SPOKE = new ethers.Interface([
  "event Borrow(uint256 indexed reserveId,address indexed caller,address indexed user,uint256 drawnShares,uint256 drawnAmount)",
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getReserveCount() view returns (uint256)",
  "function getReserve(uint256 reserveId) view returns (address,address,uint16,uint8,uint24,uint8,uint32)",
  "function getReserveConfig(uint256 reserveId) view returns (uint24,bool,bool,bool,bool)",
  "function getDynamicReserveConfig(uint256 reserveId,uint32 dynamicConfigKey) view returns (uint16,uint32,uint16)",
  "function getUserReserveStatus(uint256 reserveId,address user) view returns (bool,bool)",
  "function getUserSuppliedAssets(uint256 reserveId,address user) view returns (uint256)",
  "function getUserTotalDebt(uint256 reserveId,address user) view returns (uint256)",
  "function getLiquidationBonus(uint256 reserveId,address user,uint256 healthFactor) view returns (uint256)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(value);
  } catch (_) {
    return null;
  }
}

// Deterministic on-chain reverts (CALL_EXCEPTION) are a definitive answer from
// the node, unlike transport/rate-limit failures. Keep the two distinguishable
// in sanitized artifacts without ever surfacing raw provider text.
function providerCallErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return /CALL_EXCEPTION|REVERT/i.test(code) ? "call-reverted" : "provider-call-failed";
}

async function safeProviderCall(provider, to, data) {
  try {
    return await provider.call({ to, data });
  } catch (e) {
    return { error: sanitizeError(e, providerCallErrorCode(e)) };
  }
}

function decodeResult(raw, iface, name) {
  if (!raw || typeof raw !== "string") return null;
  try {
    return iface.decodeFunctionResult(name, raw);
  } catch (_) {
    return null;
  }
}

async function callDecoded(provider, target, iface, name, args = []) {
  const raw = await safeProviderCall(provider, target, iface.encodeFunctionData(name, args));
  if (raw?.error) return { error: raw.error };
  const decoded = decodeResult(raw, iface, name);
  return decoded ? { value: decoded } : { error: "decode failed" };
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    return ethers.formatUnits(raw, decimals);
  } catch (_) {
    return null;
  }
}

function toNumberAmount(raw, decimals) {
  const formatted = formatUnits(raw, decimals);
  if (formatted === null) return null;
  const n = Number(formatted);
  return Number.isFinite(n) ? n : null;
}

function usd(amount, priceUsd) {
  if (!Number.isFinite(amount) || !Number.isFinite(priceUsd)) return null;
  return amount * priceUsd;
}

function wadToNumber(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const n = Number(ethers.formatUnits(raw, 18));
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

function extractTopicAddress(topic) {
  if (!topic || topic.length < 42) return null;
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

async function getLogsBatched(provider, filter, fromBlock, toBlock) {
  const logs = [];
  const errors = [];
  let attempted = 0;
  let succeeded = 0;
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS + 1) {
    const end = Math.min(toBlock, start + LOG_CHUNK_BLOCKS);
    attempted += 1;
    try {
      logs.push(...await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }));
      succeeded += 1;
    } catch (e) {
      errors.push({ fromBlock: start, toBlock: end, error: sanitizeError(e, "log-query-failed") });
    }
  }
  return { logs, errors, attempted, succeeded, failed: attempted - succeeded };
}

function buildSourceCoverage(input = {}, nowMs = Date.now()) {
  const {
    topologyGeneratedAt, chainsExpected, chainsObserved, topologyRefreshAttempted = false,
    topologyRefreshOk = !topologyRefreshAttempted, topologyRefreshError = "topology-refresh-failed",
    topologySourceComplete = false,
    topologySourceSampleComplete = topologySourceComplete,
    topologyUniverse = null, spokeReserveLinks = [],
    spokesExpected = 0, spokesObserved = 0, logChunksAttempted, logChunksSucceeded,
    logChunksFailed, discoveredBorrowers = 0, checkedBorrowers = 0,
    accountReadsAttempted = 0, accountReadsSucceeded = 0, accountReadsFailed = 0,
    reserveReadsAttempted = 0, reserveReadsSucceeded = 0, reserveReadsFailed = 0,
    truncationLimit = MAX_USERS_PER_SPOKE, wasTruncated = false, errors = [],
    observedRange = { fromBlock: null, toBlock: null }, historyScope = "UNDECLARED",
    historyStartBound = null, fullHistoryProven: declaredFullHistoryProven = false,
    excludedSpokes = [],
    coverageKind = "borrower-scan",
    upstreamCoverage = null,
    observationPin = null,
  } = input;
  const upstreamKind = coverageKind === "monitor" ? "borrower-scan" : "topology";
  const structural = validateAaveSourceCoverageEnvelope(upstreamCoverage, {
    protocolVersion: "V4", coverageKind: upstreamKind,
  });
  const upstreamValidation = validateAaveSourceCoverageEnvelope(upstreamCoverage, {
    protocolVersion: "V4", coverageKind: upstreamKind, requireSampleComplete: true,
  });
  // Structurally valid context remains useful even if its borrower sample is
  // incomplete. Sample readiness and topology authority are checked separately.
  const structuralUpstream = structural.valid ? upstreamCoverage : null;
  const topologyEvidence = upstreamKind === "topology" ? structuralUpstream : structuralUpstream?.topologySourceCoverage || null;
  // Older incomplete envelopes may retain provenanced bound/sample context, as
  // before, but never gain exhaustive authority without the supporting envelope.
  const retainContext = upstreamValidation.valid || topologyEvidence !== null
    || (structuralUpstream?.topologySourceSampleComplete === true
      && boundTopologyProvenanceFailure(structuralUpstream.topologyUniverse) === null);
  const trustedUpstream = retainContext ? structuralUpstream : null;
  const trustedTopologyUniverse = trustedUpstream?.topologyUniverse || null;
  const trustedSpokeReserveLinks = Array.isArray(trustedUpstream?.spokeReserveLinks) ? trustedUpstream.spokeReserveLinks : [];
  const topologyTime = Date.parse(topologyGeneratedAt);
  const topologyAgeMs = Number.isFinite(topologyTime) ? nowMs - topologyTime : null;
  const sanitizedErrors = [];
  if (!upstreamValidation.valid) sanitizedErrors.push(...upstreamValidation.failures.map(code => `upstream-${code}`));
  if (!Number.isFinite(topologyTime)) sanitizedErrors.push("topology-generated-at-invalid");
  else if (topologyAgeMs < -60_000) sanitizedErrors.push("topology-generated-at-future");
  else if (topologyAgeMs > TOPOLOGY_MAX_AGE_MS) sanitizedErrors.push("topology-stale");
  if (chainsExpected !== CHAINS_EXPECTED) sanitizedErrors.push("required-chain-set-mismatch");
  if (chainsObserved !== CHAINS_EXPECTED) sanitizedErrors.push("required-chain-failed");
  if (topologyRefreshAttempted && !topologyRefreshOk) {
    sanitizedErrors.push(COVERAGE_ERROR_CODES.has(topologyRefreshError) ? topologyRefreshError : "topology-refresh-failed");
  }
  if (trustedUpstream?.sampleComplete !== true) sanitizedErrors.push(coverageKind === "monitor" ? "borrower-source-incomplete" : "topology-source-incomplete");
  const trustedSpokesExpected = Number.isInteger(trustedUpstream?.spokesExpected) && trustedUpstream.spokesExpected >= 0
    ? trustedUpstream.spokesExpected : 0;
  if (!trustedUpstream || spokesObserved !== trustedSpokesExpected) sanitizedErrors.push("required-spoke-failed");
  if (excludedSpokes.length > 0) sanitizedErrors.push("spoke-filtered");
  const fromBlock = observedRange?.fromBlock;
  const toBlock = observedRange?.toBlock;
  const validObservedRange = Number.isSafeInteger(fromBlock) && Number.isSafeInteger(toBlock) && fromBlock >= 0 && toBlock >= fromBlock;
  const fullHistoryProven = fullV4HistoryProven({ observedRange, historyScope, historyStartBound, fullHistoryProven: declaredFullHistoryProven });
  const chunkCountsValid = [logChunksAttempted, logChunksSucceeded, logChunksFailed]
    .every((value) => Number.isInteger(value) && value >= 0);
  if (!chunkCountsValid || logChunksSucceeded + logChunksFailed !== logChunksAttempted) sanitizedErrors.push("log-chunk-coverage-invalid");
  if (logChunksAttempted === 0) sanitizedErrors.push("log-chunk-coverage-empty");
  if (logChunksFailed > 0 || logChunksSucceeded !== logChunksAttempted) sanitizedErrors.push("log-chunk-failed");
  if (wasTruncated) sanitizedErrors.push("borrower-truncated");
  if (!Number.isSafeInteger(truncationLimit) || truncationLimit <= 0) sanitizedErrors.push("borrower-cap-invalid");
  if (discoveredBorrowers !== checkedBorrowers || accountReadsAttempted !== checkedBorrowers) sanitizedErrors.push("borrower-check-incomplete");
  if (accountReadsFailed > 0 || accountReadsSucceeded !== accountReadsAttempted) sanitizedErrors.push("account-read-failed");
  if (reserveReadsFailed > 0 || reserveReadsSucceeded !== reserveReadsAttempted) sanitizedErrors.push("reserve-read-failed");
  if (![discoveredBorrowers, checkedBorrowers, accountReadsAttempted, accountReadsSucceeded, accountReadsFailed,
    reserveReadsAttempted, reserveReadsSucceeded, reserveReadsFailed].every(value => Number.isSafeInteger(value) && value >= 0)) sanitizedErrors.push("borrower-counts-invalid");
  for (const error of errors) {
    const code = typeof error === "string" ? error : error?.error;
    if (COVERAGE_ERROR_CODES.has(code)) sanitizedErrors.push(code);
    else if (code) sanitizedErrors.push("source-error");
  }
  const uniqueErrors = [...new Set(sanitizedErrors)];
  const sampleComplete = uniqueErrors.length === 0;
  const topologyAuthority = validateV4TopologyAuthority(topologyEvidence);
  const count = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
  const stateReadsAttempted = count(accountReadsAttempted) + count(reserveReadsAttempted);
  const stateReadsSucceeded = count(accountReadsSucceeded) + count(reserveReadsSucceeded);
  const stateReadsFailed = count(accountReadsFailed) + count(reserveReadsFailed);
  const evidence = {
    sampleComplete,
    observedRange: validObservedRange ? { fromBlock, toBlock } : { fromBlock: null, toBlock: null },
    historyScope,
    historyStartBound: historyStartBound || null,
    fullHistoryProven,
    topologySourceCoverage: topologyEvidence ? structuredClone(topologyEvidence) : null,
    observationPin: observationPin ? structuredClone(observationPin) : null,
    topologyGeneratedAt: Number.isFinite(topologyTime) ? topologyGeneratedAt : null,
    topologyAgeMs,
    topologyRefreshAttempted: Boolean(topologyRefreshAttempted),
    topologyRefreshOk: Boolean(topologyRefreshOk),
    topologySourceComplete: topologyEvidence?.complete === true,
    topologySourceSampleComplete: topologyEvidence ? topologyEvidence.sampleComplete === true : trustedUpstream?.topologySourceSampleComplete === true,
    topologyUniverse: trustedTopologyUniverse,
    spokeReserveLinks: trustedSpokeReserveLinks.map(row => ({ ...row, links: row.links.map(link => ({ ...link })) })),
    consumedReserveLinks: Array.isArray(trustedUpstream?.consumedReserveLinks) ? trustedUpstream.consumedReserveLinks.map(row => ({ ...row })) : [],
    reserveLinksExpected: count(trustedUpstream?.reserveLinksExpected),
    reserveLinksObserved: count(trustedUpstream?.reserveLinksObserved),
    reserveLinksConsumed: count(trustedUpstream?.reserveLinksConsumed),
    reserveLinksCap: count(trustedUpstream?.reserveLinksCap),
    reserveLinksTruncated: trustedUpstream?.reserveLinksTruncated === true,
    chainsExpected: CHAINS_EXPECTED,
    chainsObserved: count(chainsObserved),
    spokesExpected: trustedSpokesExpected,
    spokesObserved: count(spokesObserved),
    excludedSpokes: excludedSpokes.map((row) => ({
      hub: row?.hub || null,
      spoke: row?.spoke || null,
      reasons: Array.isArray(row?.reasons) ? row.reasons.slice() : [],
    })),
    spokeFilteringApplied: excludedSpokes.length > 0,
    logChunksAttempted: count(logChunksAttempted),
    logChunksSucceeded: count(logChunksSucceeded),
    logChunksFailed: count(logChunksFailed),
    discoveredBorrowers: count(discoveredBorrowers),
    checkedBorrowers: count(checkedBorrowers),
    accountReadsAttempted: count(accountReadsAttempted),
    accountReadsSucceeded: count(accountReadsSucceeded),
    accountReadsFailed: count(accountReadsFailed),
    reserveReadsAttempted: count(reserveReadsAttempted),
    reserveReadsSucceeded: count(reserveReadsSucceeded),
    reserveReadsFailed: count(reserveReadsFailed),
    stateReadsAttempted,
    stateReadsSucceeded,
    stateReadsFailed,
    truncationLimit: count(truncationLimit),
    wasTruncated: Boolean(wasTruncated),
    errors: uniqueErrors,
  };
  const exhaustive = validateV4ExhaustiveEvidence(evidence);
  return buildAaveSourceCoverage("V4", coverageKind, {
    ...evidence,
    complete: exhaustive.valid,
    exhaustiveProof: exhaustive.proof,
    blocker: !sampleComplete
      ? `Borrower sample is incomplete: ${uniqueErrors.join(", ")}.`
      : !fullHistoryProven
        ? "Borrower discovery covers a bounded window; full active-position history is unproven."
        : !topologyAuthority.valid
          ? `Topology authority evidence is missing or invalid: ${topologyAuthority.failures.join(", ")}.`
          : !exhaustive.valid
            ? `Finalized same-pin state evidence is missing or inconsistent: ${exhaustive.failures.join(", ")}.`
            : null,
  });
}

function buildSpokeSelection(hubsArtifact, options = {}) {
  const expectedSpokes = [];
  const includedSpokes = [];
  const excludedSpokes = [];
  const detailByLink = new Map();
  const spokeMeta = new Map();
  for (const hub of hubsArtifact.hubs || []) {
    const assetsById = new Map((hub.assets || []).map((asset) => [Number(asset.assetId), asset]));
    for (const dep of hub.listedSpokeDependencies || []) {
      const spokeKey = dep.address?.toLowerCase?.();
      if (!spokeKey) continue;
      const meta = spokeMeta.get(spokeKey) || { spoke: dep.address, hubs: [], totalAddedAssetsUsd: 0, totalOwedUsd: 0 };
      meta.hubs.push({ hub: hub.name, hubAddress: hub.address });
      meta.totalAddedAssetsUsd += Number(dep.totalAddedAssetsUsd) || 0;
      meta.totalOwedUsd += Number(dep.totalOwedUsd) || 0;
      spokeMeta.set(spokeKey, meta);
      for (const row of dep.linkedAssets || []) {
        // `Number(null)` is 0; only a genuine non-negative integer reserve id
        // may become a topology link.
        const linkedReserveId = row?.reserve?.reserveId;
        if (!Number.isInteger(linkedReserveId) || linkedReserveId < 0) continue;
        const asset = assetsById.get(Number(row.assetId)) || {};
        const key = `${hub.address.toLowerCase()}:${Number(row.assetId)}:${spokeKey}:${Number(row.reserve.reserveId)}`;
        detailByLink.set(key, {
          ...row,
          hub: hub.name,
          hubAddress: hub.address,
          spoke: dep.address,
          assetId: Number(row.assetId),
          reserveId: Number(row.reserve.reserveId),
          decimals: asset.decimals ?? null,
          priceUsd: asset.priceUsd ?? row.reserve?.oracleData?.referencePriceUsd ?? null,
        });
      }
    }
  }
  const grouped = new Map();
  for (const link of hubsArtifact.sourceCoverage?.consumedReserveLinks || []) {
    const spokeKey = link.spoke?.toLowerCase?.();
    if (!spokeKey) continue;
    const key = `${link.hubAddress.toLowerCase()}:${Number(link.assetId)}:${spokeKey}:${Number(link.reserveId)}`;
    const group = grouped.get(spokeKey) || { spoke: link.spoke, linkedAssets: [], missing: 0 };
    const detail = detailByLink.get(key);
    if (detail) group.linkedAssets.push(detail);
    else group.missing += 1;
    grouped.set(spokeKey, group);
  }
  for (const [spokeKey, group] of grouped) {
    const meta = spokeMeta.get(spokeKey) || { spoke: group.spoke, hubs: [], totalAddedAssetsUsd: 0, totalOwedUsd: 0 };
    const expected = { hub: meta.hubs.map(row => row.hub).join(", ") || null, hubLinks: meta.hubs, spoke: group.spoke };
    expectedSpokes.push(expected);
    const reasons = [];
    if (!options.completeUniverse && meta.totalOwedUsd < MIN_SPOKE_OWED_USD) reasons.push("below-minimum-owed-usd");
    if (!group.linkedAssets.length) reasons.push("no-linked-reserves");
    if (group.missing > 0) reasons.push("missing-topology-link");
    const selected = { ...expected, totalAddedAssetsUsd: meta.totalAddedAssetsUsd, totalOwedUsd: meta.totalOwedUsd, linkedAssets: group.linkedAssets };
    if (reasons.length) excludedSpokes.push({ ...expected, reasons });
    else includedSpokes.push(selected);
  }
  includedSpokes.sort(options.completeUniverse
    ? (a, b) => a.spoke.toLowerCase().localeCompare(b.spoke.toLowerCase())
    : (a, b) => (b.totalOwedUsd || 0) - (a.totalOwedUsd || 0));
  return { expectedSpokes, includedSpokes, excludedSpokes };
}

function buildSpokeInputs(hubsArtifact) {
  return buildSpokeSelection(hubsArtifact).includedSpokes;
}

function decodeAccountData(result) {
  if (!result.value) return { error: result.error || "unavailable" };
  const [riskPremium, avgCollateralFactor, healthFactor, totalCollateralValue, totalDebtValueRay, activeCollateralCount, borrowCount] = result.value;
  return {
    riskPremiumBps: Number(riskPremium),
    avgCollateralFactorRaw: avgCollateralFactor,
    avgCollateralFactor: wadToNumber(avgCollateralFactor),
    healthFactorRaw: healthFactor,
    healthFactor: healthFactor === ethers.MaxUint256 ? Number.POSITIVE_INFINITY : wadToNumber(healthFactor),
    totalCollateralValueRaw: totalCollateralValue,
    totalDebtValueRayRaw: totalDebtValueRay,
    activeCollateralCount: Number(activeCollateralCount),
    borrowCount: Number(borrowCount),
    error: null,
  };
}

async function readUserReserve(provider, spoke, row, user, healthFactorRaw) {
  const reserveId = row.reserve.reserveId;
  const decimals = row.decimals;
  const priceUsd = row.priceUsd;
  const [statusResult, suppliedResult, debtResult] = await Promise.all([
    callDecoded(provider, spoke, SPOKE, "getUserReserveStatus", [reserveId, user]),
    callDecoded(provider, spoke, SPOKE, "getUserSuppliedAssets", [reserveId, user]),
    callDecoded(provider, spoke, SPOKE, "getUserTotalDebt", [reserveId, user]),
  ]);
  const suppliedRaw = suppliedResult.value ? suppliedResult.value[0] : null;
  const debtRaw = debtResult.value ? debtResult.value[0] : null;
  let liquidationBonus = null;
  let bonusError = null;
  // `getLiquidationBonus` is only defined for a health factor at or below 1 WAD;
  // an above-1 WAD health factor panics OVERFLOW(17) inside the Spoke. Clamp the
  // probe to the liquidation boundary so healthy positions get the baseline bonus
  // instead of a deterministic revert.
  const bonusHealthFactor = healthFactorRaw !== null && healthFactorRaw !== undefined
    ? (ethers.toBigInt(healthFactorRaw) > WAD ? WAD : ethers.toBigInt(healthFactorRaw))
    : null;
  // Bonus is meaningful only for collateral actually supplied by this user.
  // Still read all three core views for EVERY declared user/reserve pair.
  const bonusRequired = bonusHealthFactor !== null && suppliedRaw > 0n && statusResult.value?.[0] === true;
  if (bonusRequired) {
    const bonusResult = await callDecoded(provider, spoke, SPOKE, "getLiquidationBonus", [reserveId, user, bonusHealthFactor]);
    liquidationBonus = bonusResult.value ? Number(bonusResult.value[0]) : null;
    bonusError = bonusResult.error || null;
  }
  const supplied = toNumberAmount(suppliedRaw, decimals);
  const debt = toNumberAmount(debtRaw, decimals);
  return {
    reserveId,
    assetId: row.assetId,
    symbol: row.symbol,
    usingAsCollateral: statusResult.value ? Boolean(statusResult.value[0]) : null,
    borrowing: statusResult.value ? Boolean(statusResult.value[1]) : null,
    suppliedRaw,
    supplied,
    suppliedUsd: usd(supplied, priceUsd),
    debtRaw,
    debt,
    debtUsd: usd(debt, priceUsd),
    reserveConfig: row.reserve.reserveConfig || null,
    dynamicConfig: row.reserve.dynamicConfig || null,
    oracleData: row.reserve.oracleData || null,
    liquidationBonusBps: liquidationBonus,
    errors: {
      status: statusResult.error || null,
      supplied: suppliedResult.error || null,
      debt: debtResult.error || null,
      liquidationBonus: bonusError,
    },
    optionalRead: {
      name: "liquidationBonus",
      attempted: bonusRequired,
      error: bonusError,
      reverted: bonusError === "call-reverted",
      clampedHealthFactor: bonusRequired && healthFactorRaw !== null && healthFactorRaw !== undefined
        ? ethers.toBigInt(healthFactorRaw) > WAD
        : false,
    },
  };
}

function emptyReserveReadCoverage() {
  return {
    attempted: 0, succeeded: 0, failed: 0,
    optionalAttempted: 0, optionalSucceeded: 0, optionalReverted: 0, optionalFailed: 0,
  };
}

async function scoreUser(provider, spokeInput, user, borrowMeta) {
  const accountResult = await callDecoded(provider, spokeInput.spoke, SPOKE, "getUserAccountData", [user]);
  const account = decodeAccountData(accountResult);
  if (account.error) return { user, account, borrowMeta, reserves: [], reserveReadCoverage: emptyReserveReadCoverage(), liquidatable: false, nearLiquidation: false };
  const activeRows = [];
  const reserveReadCoverage = emptyReserveReadCoverage();
  for (const row of spokeInput.linkedAssets) {
    const reserve = await readUserReserve(provider, spokeInput.spoke, row, user, account.healthFactorRaw);
    const coreErrors = [reserve.errors?.status, reserve.errors?.supplied, reserve.errors?.debt];
    const optional = reserve.optionalRead || { attempted: false, error: null, reverted: false };
    if (optional.attempted) {
      reserveReadCoverage.optionalAttempted += 1;
      if (!optional.error) reserveReadCoverage.optionalSucceeded += 1;
      else if (optional.reverted) reserveReadCoverage.optionalReverted += 1;
      else reserveReadCoverage.optionalFailed += 1;
    }
    reserveReadCoverage.attempted += 1;
    // Core reserve reads stay fail-closed. A deterministic revert on the optional
    // liquidation-bonus probe is explicit accounting, not a read failure; a genuine
    // transport failure on it still fails the row closed.
    const genuineFailure = coreErrors.some(Boolean) || (optional.attempted && optional.error && !optional.reverted);
    if (genuineFailure) reserveReadCoverage.failed += 1;
    else reserveReadCoverage.succeeded += 1;
    if ((reserve.suppliedUsd || 0) > 0 || (reserve.debtUsd || 0) > 0 || reserve.usingAsCollateral || reserve.borrowing) activeRows.push(reserve);
  }
  const health = account.healthFactor;
  const liquidatable = Number.isFinite(health) && health < 1;
  const nearLiquidation = Number.isFinite(health) && health >= 1 && health < 1.05;
  const debts = activeRows.filter((row) => (row.debtUsd || 0) > 0);
  const collaterals = activeRows.filter((row) => (row.suppliedUsd || 0) > 0 && row.usingAsCollateral !== false);
  let bestGrossBonusUsd = 0;
  let bestPair = null;
  for (const debt of debts) {
    for (const collateral of collaterals) {
      const bonusBps = collateral.liquidationBonusBps;
      if (!Number.isFinite(bonusBps) || bonusBps <= 10000) continue;
      const repayUsd = Math.min(debt.debtUsd || 0, collateral.suppliedUsd || 0);
      const grossBonusUsd = repayUsd * ((bonusBps - 10000) / 10000);
      if (grossBonusUsd > bestGrossBonusUsd) {
        bestGrossBonusUsd = grossBonusUsd;
        bestPair = { debtReserveId: debt.reserveId, debtSymbol: debt.symbol, collateralReserveId: collateral.reserveId, collateralSymbol: collateral.symbol, liquidationBonusBps: bonusBps, grossBonusUsd };
      }
    }
  }
  return {
    user,
    account,
    borrowMeta,
    reserves: activeRows,
    reserveReadCoverage,
    liquidatable,
    nearLiquidation,
    bestPair,
    bestGrossBonusUsd,
  };
}

async function scanSpoke(provider, spokeInput, fromBlock, toBlock) {
  const { logs, errors, attempted, succeeded, failed } = await getLogsBatched(provider, {
    address: spokeInput.spoke,
    topics: [SPOKE.getEvent("Borrow").topicHash],
  }, fromBlock, toBlock);
  const users = new Map();
  for (const log of logs) {
    const user = extractTopicAddress(log.topics[3]);
    if (!user) continue;
    const current = users.get(user) || { user, borrowEvents: 0, lastBorrowBlock: 0 };
    current.borrowEvents += 1;
    current.lastBorrowBlock = Math.max(current.lastBorrowBlock, Number(log.blockNumber));
    users.set(user, current);
  }
  const wasTruncated = users.size > MAX_USERS_PER_SPOKE;
  const orderedUsers = [...users.values()].sort((a, b) => b.lastBorrowBlock - a.lastBorrowBlock).slice(0, MAX_USERS_PER_SPOKE);
  const scoredUsers = [];
  for (const meta of orderedUsers) scoredUsers.push(await scoreUser(provider, spokeInput, meta.user, meta));
  const activeBorrowers = scoredUsers.filter((row) => (row.account?.borrowCount || 0) > 0);
  const liquidatable = scoredUsers.filter((row) => row.liquidatable);
  const nearLiquidation = scoredUsers.filter((row) => row.nearLiquidation);
  const bestHealthFactor = scoredUsers.reduce((best, row) => {
    const hf = row.account?.healthFactor;
    return Number.isFinite(hf) && hf < best ? hf : best;
  }, Number.POSITIVE_INFINITY);
  const maxGrossBonusUsd = scoredUsers.reduce((max, row) => Math.max(max, row.bestGrossBonusUsd || 0), 0);
  return {
    hub: spokeInput.hub,
    hubAddress: spokeInput.hubAddress,
    spoke: spokeInput.spoke,
    totalOwedUsd: spokeInput.totalOwedUsd,
    linkedAssets: spokeInput.linkedAssets.length,
    fromBlock,
    toBlock,
    logsScanned: logs.length,
    logChunksAttempted: attempted,
    logChunksSucceeded: succeeded,
    logChunksFailed: failed,
    logErrors: errors,
    usersDiscovered: users.size,
    usersScored: scoredUsers.length,
    accountReadsAttempted: scoredUsers.length,
    accountReadsSucceeded: scoredUsers.filter((row) => !row.account?.error).length,
    accountReadsFailed: scoredUsers.filter((row) => Boolean(row.account?.error)).length,
    reserveReadsAttempted: scoredUsers.reduce((sum, row) => sum + (row.reserveReadCoverage?.attempted || 0), 0),
    reserveReadsSucceeded: scoredUsers.reduce((sum, row) => sum + (row.reserveReadCoverage?.succeeded || 0), 0),
    reserveReadsFailed: scoredUsers.reduce((sum, row) => sum + (row.reserveReadCoverage?.failed || 0), 0),
    optionalReserveReadsAttempted: scoredUsers.reduce((sum, row) => sum + (row.reserveReadCoverage?.optionalAttempted || 0), 0),
    optionalReserveReadsSucceeded: scoredUsers.reduce((sum, row) => sum + (row.reserveReadCoverage?.optionalSucceeded || 0), 0),
    optionalReserveReadsReverted: scoredUsers.reduce((sum, row) => sum + (row.reserveReadCoverage?.optionalReverted || 0), 0),
    optionalReserveReadsFailed: scoredUsers.reduce((sum, row) => sum + (row.reserveReadCoverage?.optionalFailed || 0), 0),
    truncationLimit: MAX_USERS_PER_SPOKE,
    wasTruncated,
    activeBorrowers: activeBorrowers.length,
    nearLiquidation: nearLiquidation.length,
    liquidatable: liquidatable.length,
    bestHealthFactor: bestHealthFactor === Number.POSITIVE_INFINITY ? null : bestHealthFactor,
    maxGrossBonusUsd,
    topUsers: scoredUsers
      .filter((row) => (row.account?.borrowCount || 0) > 0 || row.liquidatable || row.nearLiquidation)
      .sort((a, b) => {
        const ah = Number.isFinite(a.account?.healthFactor) ? a.account.healthFactor : Number.POSITIVE_INFINITY;
        const bh = Number.isFinite(b.account?.healthFactor) ? b.account.healthFactor : Number.POSITIVE_INFINITY;
        return ah - bh;
      })
      .slice(0, 20),
  };
}

async function scorePage(context, spokeInput, page) {
  const cache = new Map();
  const request = (name, args) => ({ to: spokeInput.spoke, data: SPOKE.encodeFunctionData(name, args) });
  async function prefetch(calls) {
    const results = await context.provider.callMany(calls);
    calls.forEach((call, index) => cache.set(call.data, results[index]));
  }
  const provider = { async call(tx) {
    const entry = tx.to === spokeInput.spoke ? cache.get(tx.data) : null;
    if (!entry || entry.error) throw new CollectionError(entry?.error || "PREFETCH_MISSING");
    return entry.value;
  } };
  await prefetch(page.map(meta => request("getUserAccountData", [meta.user])));
  const reserves = [];
  for (const meta of page) {
    const account = decodeAccountData(await callDecoded(provider, spokeInput.spoke, SPOKE, "getUserAccountData", [meta.user]));
    if (account.error) continue;
    for (const row of spokeInput.linkedAssets) {
      for (const name of ["getUserReserveStatus", "getUserSuppliedAssets", "getUserTotalDebt"]) {
        reserves.push(request(name, [row.reserve.reserveId, meta.user]));
      }
    }
  }
  // The same scorer consumes exact raw results, including per-call errors. No
  // debt-free user or reserve is skipped and the cache lasts for one page only.
  await prefetch(reserves);
  // Do not spend the pinned collection deadline probing an optional bonus for
  // thousands of empty/non-collateral reserve pairs. Eligibility is established
  // from the same-pin core results, never inferred from historical activity.
  const bonuses = [];
  for (const meta of page) {
    const account = decodeAccountData(await callDecoded(provider, spokeInput.spoke, SPOKE, "getUserAccountData", [meta.user]));
    if (account.error) continue;
    const health = account.healthFactorRaw > WAD ? WAD : account.healthFactorRaw;
    for (const row of spokeInput.linkedAssets) {
      const reserveId = row.reserve.reserveId;
      const status = await callDecoded(provider, spokeInput.spoke, SPOKE, "getUserReserveStatus", [reserveId, meta.user]);
      const supplied = await callDecoded(provider, spokeInput.spoke, SPOKE, "getUserSuppliedAssets", [reserveId, meta.user]);
      if (status.value?.[0] === true && supplied.value?.[0] > 0n) {
        bonuses.push(request("getLiquidationBonus", [reserveId, meta.user, health]));
      }
    }
  }
  if (bonuses.length) await prefetch(bonuses);
  return Promise.all(page.map(meta => scoreUser(provider, spokeInput, meta.user, meta)));
}

async function scanIndexedSpoke(context, spokeInput, entries, options) {
  const scored = [];
  let pages = 0;
  for (let offset = 0; offset < entries.length; offset += options.pageSize) {
    if (!context.canCollect() || options.remainingUsers <= 0) break;
    const page = entries.slice(offset, Math.min(entries.length, offset + options.pageSize, offset + options.remainingUsers));
    pages += 1;
    if (options.batchReads) {
      scored.push(...await scorePage(context, spokeInput, page));
      options.remainingUsers -= page.length;
    } else {
      for (const meta of page) {
        if (!context.canCollect() || options.remainingUsers <= 0) break;
        scored.push(await scoreUser(context.provider, spokeInput, meta.user, meta));
        options.remainingUsers -= 1;
      }
    }
    if (scored.length < Math.min(entries.length, offset + options.pageSize)) break;
  }
  const healthy = scored.map(row => row.account?.healthFactor).filter(Number.isFinite);
  const reserveSum = key => scored.reduce((sum, row) => sum + (row.reserveReadCoverage?.[key] || 0), 0);
  return {
    hub: spokeInput.hub, spoke: spokeInput.spoke, linkedAssets: spokeInput.linkedAssets.length,
    usersDiscovered: entries.length, usersScored: scored.length, pagesChecked: pages,
    logChunksAttempted: 0, logChunksSucceeded: 0, logChunksFailed: 0, logsScanned: 0, logErrors: [],
    accountReadsAttempted: scored.length,
    accountReadsSucceeded: scored.filter(row => !row.account?.error).length,
    accountReadsFailed: scored.filter(row => row.account?.error).length,
    reserveReadsAttempted: reserveSum("attempted"), reserveReadsSucceeded: reserveSum("succeeded"), reserveReadsFailed: reserveSum("failed"),
    optionalReserveReadsAttempted: reserveSum("optionalAttempted"), optionalReserveReadsSucceeded: reserveSum("optionalSucceeded"),
    optionalReserveReadsReverted: reserveSum("optionalReverted"), optionalReserveReadsFailed: reserveSum("optionalFailed"),
    wasTruncated: scored.length !== entries.length,
    activeBorrowers: scored.filter(row => (row.account?.borrowCount || 0) > 0).length,
    liquidatable: scored.filter(row => row.liquidatable).length, nearLiquidation: scored.filter(row => row.nearLiquidation).length,
    bestHealthFactor: healthy.length ? Math.min(...healthy) : null,
    maxGrossBonusUsd: scored.reduce((max, row) => Math.max(max, row.bestGrossBonusUsd || 0), 0),
    // Display truncation is separate from enumeration/scoring completeness.
    topUsers: scored.filter(row => (row.account?.borrowCount || 0) > 0 || row.liquidatable || row.nearLiquidation)
      .sort((a, b) => (a.account?.healthFactor ?? Infinity) - (b.account?.healthFactor ?? Infinity)).slice(0, 20),
  };
}

function collectionLimit(value, fallback, maximum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new CollectionError("COLLECTION_LIMIT_INVALID");
  return number;
}

async function collectBorrowers(hubsArtifact, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const topologyTime = Date.parse(hubsArtifact.generatedAt);
  const topologyAgeMs = now() - topologyTime;
  if (!Number.isFinite(topologyTime) || topologyAgeMs < -60_000 || topologyAgeMs > TOPOLOGY_MAX_AGE_MS) {
    throw new Error("topology-source-incomplete");
  }
  const topologyValidation = validateV4TopologyAuthority(hubsArtifact.sourceCoverage);
  if (!topologyValidation.valid) throw new Error("topology-source-incomplete");
  const topologyPin = hubsArtifact.sourceCoverage.observationPin;
  if (!validV4ObservationPin(hubsArtifact.sourceCoverage)) throw new Error("topology-pin-missing");
  const spokeSelection = buildSpokeSelection(hubsArtifact, { completeUniverse: true });
  if (spokeSelection.excludedSpokes.length) throw new Error("topology-link-missing");
  const spokes = spokeSelection.includedSpokes;
  if (!spokes.length) throw new Error("history-empty-scope");
  const batchReads = dependencies.batchReads === true;
  const pageSize = collectionLimit(dependencies.pageSize, batchReads ? 64 : 20, 100);
  const maxUsers = collectionLimit(dependencies.maxUsers, batchReads ? 10000 : 2048, 10000);
  const identity = borrowerHistory.historyIdentity(spokes.map(row => row.spoke), hubsArtifact.sourceCoverage.topologyUniverse.inventoryDigest);
  const context = await (dependencies.openCollection || openPinnedCollection)({
    ...(dependencies.collectionOptions || {}), now,
    probeAddress: hubsArtifact.hubs?.[0]?.address, requestedPin: topologyPin,
    historyProbe: { addresses: identity.spokes, topic: borrowerHistory.TOPIC },
  });
  if (context.pin.number !== topologyPin.blockNumber || context.pin.hash !== topologyPin.blockHash.toLowerCase()) throw new Error("collection-pin-mismatch");
  const directory = dependencies.indexDirectory || HISTORY_DIR;
  const store = dependencies.historyStore || {
    load: value => borrowerHistory.loadHistory(directory, value),
    save: value => borrowerHistory.persistHistory(directory, value),
  };
  const history = await borrowerHistory.advanceHistory(context, store.load(identity), dependencies.historyOptions);
  const blockNumber = context.pin.number;
  const fromBlock = 0;
  const spokeResults = [];
  const pagination = { pageSize, remainingUsers: history.complete ? maxUsers : 0, batchReads };
  for (const spoke of spokes) spokeResults.push(await scanIndexedSpoke(context, spoke, history.index.users[spoke.spoke.toLowerCase()], pagination));
  const unaccountedDebtSpokes = history.complete ? spokes.filter(spoke => {
    if (history.index.users[spoke.spoke.toLowerCase()].length) return false;
    if (spoke.totalOwedUsd > 0) return true;
    return spoke.linkedAssets.some(row => ["getSpokeOwed", "getSpokeTotalOwed"].some(key => {
      try { return BigInt(row.accounting?.views?.[key]?.raw ?? 0) > 0n; } catch (_) { return false; }
    }));
  }).map(row => row.spoke) : [];
  const allTopUsers = spokeResults.flatMap((spoke) => spoke.topUsers.map((user) => ({
    hub: spoke.hub,
    spoke: spoke.spoke,
    ...user,
  })));
  const summary = spokeResults.reduce((acc, row) => {
    acc.spokesScanned += 1;
    acc.logsScanned += row.logsScanned;
    acc.logErrorChunks += row.logErrors.length;
    acc.logChunksAttempted += row.logChunksAttempted;
    acc.logChunksSucceeded += row.logChunksSucceeded;
    acc.logChunksFailed += row.logChunksFailed;
    acc.usersDiscovered += row.usersDiscovered;
    acc.usersScored += row.usersScored;
    acc.accountReadsAttempted += row.accountReadsAttempted;
    acc.accountReadsSucceeded += row.accountReadsSucceeded;
    acc.accountReadsFailed += row.accountReadsFailed;
    acc.reserveReadsAttempted += row.reserveReadsAttempted;
    acc.reserveReadsSucceeded += row.reserveReadsSucceeded;
    acc.reserveReadsFailed += row.reserveReadsFailed;
    acc.optionalReserveReadsAttempted += row.optionalReserveReadsAttempted;
    acc.optionalReserveReadsSucceeded += row.optionalReserveReadsSucceeded;
    acc.optionalReserveReadsReverted += row.optionalReserveReadsReverted;
    acc.optionalReserveReadsFailed += row.optionalReserveReadsFailed;
    acc.wasTruncated = acc.wasTruncated || row.wasTruncated;
    acc.activeBorrowers += row.activeBorrowers;
    acc.nearLiquidation += row.nearLiquidation;
    acc.liquidatable += row.liquidatable;
    if (Number.isFinite(row.bestHealthFactor) && row.bestHealthFactor < acc.bestHealthFactor) acc.bestHealthFactor = row.bestHealthFactor;
    acc.maxGrossBonusUsd = Math.max(acc.maxGrossBonusUsd, row.maxGrossBonusUsd || 0);
    return acc;
  }, { spokesScanned: 0, logsScanned: 0, logErrorChunks: 0, logChunksAttempted: 0, logChunksSucceeded: 0, logChunksFailed: 0, usersDiscovered: 0, usersScored: 0, accountReadsAttempted: 0, accountReadsSucceeded: 0, accountReadsFailed: 0, reserveReadsAttempted: 0, reserveReadsSucceeded: 0, reserveReadsFailed: 0, optionalReserveReadsAttempted: 0, optionalReserveReadsSucceeded: 0, optionalReserveReadsReverted: 0, optionalReserveReadsFailed: 0, wasTruncated: false, activeBorrowers: 0, nearLiquidation: 0, liquidatable: 0, bestHealthFactor: Number.POSITIVE_INFINITY, maxGrossBonusUsd: 0 });
  summary.bestHealthFactor = summary.bestHealthFactor === Number.POSITIVE_INFINITY ? null : summary.bestHealthFactor;
  summary.watchCandidates = summary.liquidatable;
  summary.routePositive = 0;
  summary.signedActionJustified = false;
  summary.spokesScanned = history.complete ? spokeResults.filter(row => !row.wasTruncated).length : 0;
  summary.truncationLimit = maxUsers;
  summary.logChunksSucceeded = history.index.committedChunks;
  summary.logChunksFailed = history.reason && history.reason !== "HISTORY_BACKFILL_PENDING" ? 1 : 0;
  summary.logChunksAttempted = summary.logChunksSucceeded + summary.logChunksFailed;
  summary.logsScanned = history.index.logs;
  summary.logErrorChunks = summary.logChunksFailed;
  summary.paginationComplete = history.complete && summary.usersScored === summary.usersDiscovered && !summary.wasTruncated;
  const topologyRefreshAttempted = dependencies.topologyRefreshAttempted ?? false;
  const topologyRefreshOk = dependencies.topologyRefreshOk ?? !topologyRefreshAttempted;
  await context.confirmPin();
  const observationPin = context.observationPin({
    stateReadsAttempted: summary.accountReadsAttempted + summary.reserveReadsAttempted,
    stateReadsSucceeded: summary.accountReadsSucceeded + summary.reserveReadsSucceeded,
    stateReadsFailed: summary.accountReadsFailed + summary.reserveReadsFailed,
  });
  const sourceCoverage = buildSourceCoverage({
    topologyGeneratedAt: hubsArtifact.generatedAt,
    topologyRefreshAttempted,
    topologyRefreshOk,
    topologySourceComplete: hubsArtifact.sourceCoverage?.complete === true,
    topologySourceSampleComplete: hubsArtifact.sourceCoverage?.sampleComplete === true,
    topologyUniverse: hubsArtifact.sourceCoverage?.topologyUniverse || null,
    spokeReserveLinks: hubsArtifact.sourceCoverage?.spokeReserveLinks || [],
    upstreamCoverage: hubsArtifact.sourceCoverage,
    chainsExpected: CHAINS_EXPECTED,
    chainsObserved: 1,
    spokesExpected: spokeSelection.expectedSpokes.length,
    spokesObserved: history.complete ? spokeResults.filter(row => !row.wasTruncated).length : 0,
    excludedSpokes: spokeSelection.excludedSpokes,
    observedRange: history.index.throughBlock < 0 ? null : { fromBlock, toBlock: history.index.throughBlock },
    historyScope: history.complete ? "GENESIS_TO_TIP" : "GENESIS_BACKFILL_PENDING",
    historyStartBound: { block: 0, kind: "genesis", proven: true, proof: "genesis; contiguous validated Borrow-log checkpoint" },
    fullHistoryProven: history.complete,
    observationPin,
    logChunksAttempted: summary.logChunksAttempted,
    logChunksSucceeded: summary.logChunksSucceeded,
    logChunksFailed: summary.logChunksFailed,
    discoveredBorrowers: summary.usersDiscovered,
    checkedBorrowers: summary.usersScored,
    accountReadsAttempted: summary.accountReadsAttempted,
    accountReadsSucceeded: summary.accountReadsSucceeded,
    accountReadsFailed: summary.accountReadsFailed,
    reserveReadsAttempted: summary.reserveReadsAttempted,
    reserveReadsSucceeded: summary.reserveReadsSucceeded,
    reserveReadsFailed: summary.reserveReadsFailed,
    optionalReserveReadsAttempted: summary.optionalReserveReadsAttempted,
    optionalReserveReadsSucceeded: summary.optionalReserveReadsSucceeded,
    optionalReserveReadsReverted: summary.optionalReserveReadsReverted,
    optionalReserveReadsFailed: summary.optionalReserveReadsFailed,
    truncationLimit: maxUsers,
    wasTruncated: summary.wasTruncated,
    errors: [
      ...(!history.complete ? [summary.logChunksFailed ? "history-query-failed" : "history-backfill-pending"] : []),
      ...(history.complete && !summary.paginationComplete ? ["borrower-pagination-incomplete"] : []),
      ...(unaccountedDebtSpokes.length ? ["borrower-history-debt-unaccounted"] : []),
    ],
  }, now());

  const out = {
    generatedAt: new Date(now()).toISOString(),
    scanner: "tools/scan-aave-v4-spoke-borrowers.js",
    scope: "Aave V4 registry-bound Borrow-event history and same-pin borrower observation",
    classification: sourceCoverage.classification,
    complete: sourceCoverage.complete,
    blocker: sourceCoverage.blocker,
    sourceCoverage,
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    chain: { id: ETHEREUM_CHAIN_ID, name: "Ethereum", blockNumber, blockHash: context.pin.hash, stateRoot: context.pin.stateRoot, timestamp: Number(context.pin.timestamp), finality: "finalized" },
    collection: context.statistics(),
    history: {
      schema: history.index.schema, identityDigest: history.index.identityDigest,
      throughBlock: history.index.throughBlock, throughBlockHash: history.index.throughBlockHash,
      targetBlock: blockNumber, complete: history.complete, reason: history.reason,
      committedChunks: history.index.committedChunks, committedThisPass: history.committedThisPass, requestsThisPass: history.requests,
      enumeration: "all decoded Borrow-event users since genesis for the declared reserve-bearing spoke set",
      runtimeEquivalence: "not-established-by-enumeration",
      unaccountedDebtSpokes,
    },
    sourceArtifact: path.relative(WORKSPACE, HUBS_FILE),
    topologySelection: {
      expectedSpokes: spokeSelection.expectedSpokes,
      includedSpokes: spokes.map((row) => ({ hub: row.hub, hubAddress: row.hubAddress, spoke: row.spoke })),
      excludedSpokes: spokeSelection.excludedSpokes,
    },
    query: { fromBlock, toBlock: blockNumber, pageSize, maxUsersPerPass: maxUsers, minSpokeOwedUsd: 0, pin: "EIP-1898", historyMode: "GENESIS_CHECKPOINT", stateReadMode: batchReads ? "SPOKE_VIEW_MULTICALL" : "DIRECT" },
    gates: {
      routePositiveRequires: [
        "live liquidatable user with decoded debt/collateral reserves",
        "exact repay token acquisition and collateral exit quotes",
        "gas-adjusted positive liquidation economics",
        "fork-positive extraction proof",
      ],
    },
    summary,
    spokes: spokeResults,
    topUsers: allTopUsers
      .sort((a, b) => {
        const ah = Number.isFinite(a.account?.healthFactor) ? a.account.healthFactor : Number.POSITIVE_INFINITY;
        const bh = Number.isFinite(b.account?.healthFactor) ? b.account.healthFactor : Number.POSITIVE_INFINITY;
        return ah - bh;
      })
      .slice(0, 30),
    watchCandidates: allTopUsers.filter((row) => row.liquidatable).slice(0, 20),
    positiveRoutes: [],
  };
  // No history or observation publication precedes the terminal pin check.
  if (history.committedThisPass) store.save(history.index);
  return out;
}

async function main() {
  const aaveFamilyCandidates = require("./lib/aave-v4-family-candidates");
  const familyInjection = aaveFamilyCandidates.buildCandidates(process.env);
  const option = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const input = option("--hubs") || HUBS_FILE;
  const output = option("--out") || OUT_FILE;
  const hubsArtifact = JSON.parse(fs.readFileSync(input, "utf8"));
  const out = await collectBorrowers(hubsArtifact, {
    batchReads: true,
    ...(familyInjection ? { collectionOptions: { candidates: familyInjection.candidates } } : {}),
    indexDirectory: option("--history-index-dir") || HISTORY_DIR,
    pageSize: option("--page-size"), maxUsers: option("--max-users"),
    historyOptions: { maxChunks: collectionLimit(option("--max-chunks"), 512, 512), chunkSize: collectionLimit(option("--chunk-size"), 10000, 10000) },
    topologyRefreshAttempted: argBoolean("--topology-refresh-attempted", false),
    topologyRefreshOk: argBoolean("--topology-refresh-ok", true),
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  console.log(`Aave V4 spoke borrowers: spokes=${out.summary.spokesScanned} users=${out.summary.usersScored} historyComplete=${out.history.complete} complete=${out.complete}`);
  console.log(`Report: ${path.relative(WORKSPACE, output)}`);
}

function argBoolean(name, fallback) {
  const prefix = `${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return fallback;
  return raw.slice(prefix.length).toLowerCase() === "true";
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`scan-aave-v4-spoke-borrowers failed: ${sanitizeError(e, "scanner-failed")}`);
    process.exitCode = 1;
  });
}

module.exports = { CHAINS_EXPECTED, TOPOLOGY_MAX_AGE_MS, buildSourceCoverage, buildSpokeInputs, buildSpokeSelection, collectBorrowers, scanIndexedSpoke, emptyReserveReadCoverage, getLogsBatched, providerCallErrorCode, safeProviderCall, scanSpoke, scoreUser };
