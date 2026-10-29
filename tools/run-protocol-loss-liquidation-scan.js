#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULTS = Object.freeze({
  config: path.join(__dirname, "protocol-loss-scan-config.json"),
  cache: path.join(ROOT, "reports", "monitor", "morpho-ws-cache.json"),
  startup: path.join(ROOT, "reports", "monitor", "morpho-liquidatable-startup.json"),
  oracle: path.join(ROOT, "reports", "raw", "fast", "morpho-frozen-oracle-status.json"),
  output: path.join(ROOT, "reports", "monitor", "protocol-loss-liquidation-scan.json"),
});
const SCHEMA = "protocol-loss-liquidation-scan/v1";
const CONFIG_SCHEMA = "protocol-loss-scan-config/v1";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ORACLE_PRICE_SCALE = 10n ** 36n;
const WAD = 10n ** 18n;
const VIRTUAL_SHARES = 1_000_000n;
const LIQUIDATION_CURSOR_WAD = 300_000_000_000_000_000n;
const MAX_LIQUIDATION_INCENTIVE_WAD = 1_150_000_000_000_000_000n;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

class ScanFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) { throw new ScanFailure(code); }
function isFiniteNonnegative(value) { return Number.isFinite(value) && value >= 0; }
function isPositiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }

function validateConfig(config) {
  if (!config || config.schema !== CONFIG_SCHEMA) fail("CONFIG_SCHEMA_INVALID");
  if (!isFiniteNonnegative(config.minShortfallUsd) || !isFiniteNonnegative(config.minDebtUsd)) fail("CONFIG_THRESHOLD_INVALID");
  if (!Array.isArray(config.includedChains) || config.includedChains.length === 0
      || config.includedChains.some((id) => !isPositiveInteger(id))) fail("CONFIG_CHAINS_INVALID");
  if (config.includedMarkets !== "*"
      && (!Array.isArray(config.includedMarkets) || config.includedMarkets.some((id) => !HASH_RE.test(id)))) {
    fail("CONFIG_MARKETS_INVALID");
  }
  const limits = config.limits;
  for (const key of ["maxMarkets", "maxPositions", "maxPositionsPerMarket", "maxRpcRequests", "rpcTimeoutMs", "maxOutputBytes"]) {
    if (!isPositiveInteger(limits?.[key])) fail("CONFIG_LIMIT_INVALID");
  }
  if (config.liquidation?.cursor !== 0.3 || config.liquidation?.maxIncentive !== 1.15) {
    fail("CONFIG_LIQUIDATION_INVALID");
  }
  const mapping = config.fieldMapping;
  if (!mapping || mapping.marketCollection !== "markets" || mapping.borrowerCollection !== "borrowers"
      || typeof mapping.market?.marketId !== "string" || typeof mapping.borrower?.address !== "string") {
    fail("CONFIG_MAPPING_INVALID");
  }
  return config;
}

function parseCli(argv) {
  let runOnce = false;
  for (const arg of argv) {
    if (arg === "--run-once" && !runOnce) runOnce = true;
    else fail("CLI_ARGUMENT_INVALID");
  }
  return { runOnce, networkReadsAllowed: runOnce };
}

function readJson(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) fail("INPUT_FILE_INVALID");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function asBigInt(value, code = "NUMERIC_FIELD_INVALID") {
  try {
    if (typeof value !== "string" && typeof value !== "bigint" && !Number.isSafeInteger(value)) fail(code);
    const result = BigInt(value);
    if (result < 0n) fail(code);
    return result;
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    fail(code);
  }
}

function ceilDiv(a, b) {
  if (b <= 0n) fail("BORROW_SHARE_DENOMINATOR_INVALID");
  return a / b + (a % b === 0n ? 0n : 1n);
}

function unitsToUsd(raw, decimals, usdPrice) {
  const value = Number(raw) / (10 ** decimals) * usdPrice;
  if (!Number.isFinite(value) || value < 0) fail("USD_VALUE_INVALID");
  return value;
}

function roundUsd(value) { return Number(value.toFixed(8)); }

function liquidationIncentiveWad(lltvRaw) {
  if (lltvRaw <= 0n || lltvRaw >= WAD) fail("LLTV_INVALID");
  const cursorAdjustment = LIQUIDATION_CURSOR_WAD * (WAD - lltvRaw) / WAD;
  const uncapped = WAD * WAD / (WAD - cursorAdjustment);
  return uncapped < MAX_LIQUIDATION_INCENTIVE_WAD ? uncapped : MAX_LIQUIDATION_INCENTIVE_WAD;
}

function hasUsdValuation(input) {
  return Number.isSafeInteger(input.loanDecimals) && input.loanDecimals >= 0 && input.loanDecimals <= 36
    && Number.isFinite(input.loanUsdPrice) && input.loanUsdPrice > 0;
}

function baseResult(overrides) {
  return {
    classification: "NO_PROTOCOL_LOSS_CANDIDATE",
    valuationStatus: "UNAVAILABLE",
    thresholdStatus: "NOT_APPLICABLE",
    routePositive: "n/a",
    netClaim: null,
    profitClaimed: false,
    executableRouteClaimed: false,
    flags: [],
    protocolLossCandidate: false,
    noDebt: false,
    ...overrides,
  };
}

function computePosition(input, config) {
  const borrowShares = asBigInt(input.borrowSharesRaw, "BORROW_SHARES_INVALID");
  const totalBorrowAssets = asBigInt(input.totalBorrowAssetsRaw, "MARKET_BORROW_ASSETS_INVALID");
  const totalBorrowShares = asBigInt(input.totalBorrowSharesRaw, "MARKET_BORROW_SHARES_INVALID");
  if (borrowShares > totalBorrowShares) fail("MARKET_STATE_INCONSISTENT");
  if (borrowShares === 0n) {
    return baseResult({
      classification: "NO_DEBT",
      noDebt: true,
      borrowSharesRaw: "0",
      debtRaw: "0",
      residualShortfallRaw: "0",
      shortfallUsd: null,
      liquidatable: false,
    });
  }

  const collateral = asBigInt(input.collateralRaw, "COLLATERAL_INVALID");
  const lltv = asBigInt(input.lltvRaw, "LLTV_INVALID");
  const oraclePrice = asBigInt(input.oraclePriceRaw, "ORACLE_PRICE_INVALID");
  if (oraclePrice === 0n) fail("ORACLE_PRICE_INVALID");

  const debt = ceilDiv(borrowShares * (totalBorrowAssets + 1n), totalBorrowShares + VIRTUAL_SHARES);
  const collateralValue = collateral * oraclePrice / ORACLE_PRICE_SCALE;
  const maxBorrow = collateralValue * lltv / WAD;
  const liquidatable = maxBorrow < debt;
  const incentive = liquidationIncentiveWad(lltv);
  const common = {
    borrowSharesRaw: borrowShares.toString(),
    debtRaw: debt.toString(),
    collateralValueLoanRaw: collateralValue.toString(),
    maxBorrowRaw: maxBorrow.toString(),
    healthFactorWad: (maxBorrow * WAD / debt).toString(),
    liquidatable,
    liquidationIncentiveWad: incentive.toString(),
    residualShortfallRaw: "0",
    shortfallUsd: null,
  };
  if (!liquidatable) return baseResult(common);
  if (collateral === 0n) {
    return baseResult({ ...common, classification: "FULL_SEIZURE_REQUIRES_COLLATERAL", flags: ["UNDERWATER"] });
  }

  const quoted = ceilDiv(collateral * oraclePrice, ORACLE_PRICE_SCALE);
  const repayQuote = ceilDiv(quoted * WAD, incentive);
  const repaidShares = ceilDiv(repayQuote * (totalBorrowShares + VIRTUAL_SHARES), totalBorrowAssets + 1n);
  if (repaidShares > borrowShares) {
    return baseResult({
      ...common,
      classification: "FULL_SEIZURE_REPAY_EXCEEDS_BORROW_SHARES",
      flags: ["UNDERWATER"],
      quotedCollateralValueRaw: quoted.toString(),
      fullSeizureRepaidSharesRaw: repaidShares.toString(),
    });
  }

  const repaid = ceilDiv(repaidShares * (totalBorrowAssets + 1n), totalBorrowShares + VIRTUAL_SHARES);
  const assetsAfter = totalBorrowAssets > repaid ? totalBorrowAssets - repaid : 0n;
  const sharesAfter = totalBorrowShares - repaidShares;
  const residualShares = borrowShares - repaidShares;
  const residualDebt = ceilDiv(residualShares * (assetsAfter + 1n), sharesAfter + VIRTUAL_SHARES);
  const residualShortfall = assetsAfter < residualDebt ? assetsAfter : residualDebt;
  const bonus = collateralValue > repaid ? collateralValue - repaid : 0n;
  const raw = {
    ...common,
    quotedCollateralValueRaw: quoted.toString(),
    fullSeizureRepaidSharesRaw: repaidShares.toString(),
    repaidAssetsRaw: repaid.toString(),
    residualBorrowSharesRaw: residualShares.toString(),
    residualShortfallRaw: residualShortfall.toString(),
    liquidationBonusRaw: bonus.toString(),
    flags: ["UNDERWATER"],
  };
  if (residualShortfall === 0n) return baseResult({ ...raw, classification: "LIQUIDATABLE_NO_RESIDUAL_LOSS" });

  if (!hasUsdValuation(input)) {
    return baseResult({
      ...raw,
      classification: "UNVALUED_PROTOCOL_LOSS_CANDIDATE",
      thresholdStatus: "UNKNOWN",
      protocolLossCandidate: true,
      flags: ["UNVALUED_PROTOCOL_LOSS_CANDIDATE", "UNDERWATER"],
    });
  }

  const collateralUsdValue = unitsToUsd(collateralValue, input.loanDecimals, input.loanUsdPrice);
  const debtUsdValue = unitsToUsd(debt, input.loanDecimals, input.loanUsdPrice);
  const shortfallUsdValue = unitsToUsd(residualShortfall, input.loanDecimals, input.loanUsdPrice);
  const collateralValueUsd = roundUsd(collateralUsdValue);
  const debtValueUsd = roundUsd(debtUsdValue);
  const shortfallUsd = roundUsd(shortfallUsdValue);
  const repaidValueUsd = roundUsd(unitsToUsd(repaid, input.loanDecimals, input.loanUsdPrice));
  const bonusUsd = roundUsd(unitsToUsd(bonus, input.loanDecimals, input.loanUsdPrice));
  const meetsMinDebtUsd = debtUsdValue >= config.minDebtUsd;
  const meetsMinShortfallUsd = shortfallUsdValue > config.minShortfallUsd;
  const thresholdStatus = !meetsMinDebtUsd ? "BELOW_MIN_DEBT"
    : meetsMinShortfallUsd ? "PASS" : "BELOW_MIN_SHORTFALL";
  return baseResult({
    ...raw,
    classification: "VALUED_PROTOCOL_LOSS_CANDIDATE",
    valuationStatus: "AVAILABLE",
    thresholdStatus,
    protocolLossCandidate: true,
    collateralValueUsd,
    debtValueUsd,
    seizableCollateralValueUsd: collateralValueUsd,
    shortfallUsd,
    meetsMinDebtUsd,
    meetsMinShortfallUsd,
    flags: thresholdStatus === "PASS" ? ["PROTOCOL_LOSS_LIQUIDATION", "UNDERWATER"] : ["UNDERWATER"],
    liquidatorEconomicsEstimate: {
      label: "ESTIMATES_ONLY_NO_NET_CLAIM",
      estimatedSeizedValueUsd: collateralValueUsd,
      estimatedRepayValueUsd: repaidValueUsd,
      estimatedBonusUsd: bonusUsd,
      estimatedGasUsd: roundUsd(input.estimatedGasUsd || 0),
      netClaim: null,
    },
  });
}

function safeCode(error) {
  const code = error?.code || error?.message;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "POSITION_EVALUATION_FAILED";
}

async function scanCandidates(candidates, evaluator, config) {
  const flagged = [];
  const stats = {
    positionsComputed: 0,
    positionsFailedClosed: 0,
    healthyPositions: 0,
    noDebtPositions: 0,
    liquidatablePositions: 0,
    protocolLossCandidates: 0,
    valuedProtocolLossCandidates: 0,
    unvaluedProtocolLossCandidates: 0,
    fullSeizureUnavailable: 0,
    suppressedBelowMinDebt: 0,
    suppressedBelowMinShortfall: 0,
    flagCounts: { PROTOCOL_LOSS_LIQUIDATION: 0, UNVALUED_PROTOCOL_LOSS_CANDIDATE: 0, UNDERWATER: 0 },
    failureReasons: {},
  };
  for (const candidate of candidates) {
    try {
      const inputs = await evaluator(candidate);
      const computed = computePosition(inputs, config);
      stats.positionsComputed += 1;
      if (computed.noDebt) stats.noDebtPositions += 1;
      else if (!computed.liquidatable) stats.healthyPositions += 1;
      if (computed.liquidatable) stats.liquidatablePositions += 1;
      if (computed.classification.startsWith("FULL_SEIZURE_")) stats.fullSeizureUnavailable += 1;
      if (computed.protocolLossCandidate) {
        stats.protocolLossCandidates += 1;
        if (computed.valuationStatus === "AVAILABLE") stats.valuedProtocolLossCandidates += 1;
        else stats.unvaluedProtocolLossCandidates += 1;
      }
      for (const flag of computed.flags) stats.flagCounts[flag] += 1;
      if (computed.thresholdStatus === "BELOW_MIN_DEBT") stats.suppressedBelowMinDebt += 1;
      if (computed.thresholdStatus === "BELOW_MIN_SHORTFALL") stats.suppressedBelowMinShortfall += 1;
      if (computed.protocolLossCandidate
          && (computed.valuationStatus === "UNAVAILABLE" || computed.thresholdStatus === "PASS")) {
        flagged.push({
          chainId: candidate.chainId,
          chainKey: candidate.chainKey,
          marketId: candidate.marketId.toLowerCase(),
          borrower: candidate.borrower.toLowerCase(),
          ...computed,
          oracleContext: inputs.oracleContext || null,
          valuationSource: inputs.valuationSource,
        });
      }
    } catch (error) {
      const code = safeCode(error);
      stats.positionsFailedClosed += 1;
      stats.failureReasons[code] = (stats.failureReasons[code] || 0) + 1;
    }
  }
  flagged.sort((a, b) => {
    const aRaw = BigInt(a.residualShortfallRaw);
    const bRaw = BigInt(b.residualShortfallRaw);
    if (aRaw !== bRaw) return aRaw > bRaw ? -1 : 1;
    return a.marketId.localeCompare(b.marketId) || a.borrower.localeCompare(b.borrower);
  });
  return { flagged, stats };
}

function positionKey(chainId, marketId, borrower) {
  return `${chainId}:${String(marketId).toLowerCase()}:${String(borrower).toLowerCase()}`;
}

function prepareCandidates(cache, startup, config) {
  if (!Array.isArray(cache?.markets) || !Array.isArray(cache?.borrowers)) fail("CACHE_STRUCTURE_INVALID");
  const chainSet = new Set(config.includedChains);
  const marketSet = config.includedMarkets === "*" ? null : new Set(config.includedMarkets.map((id) => id.toLowerCase()));
  const rootBorrowers = new Map();
  for (const row of cache.borrowers) {
    if (!ADDRESS_RE.test(row?.borrower || "") || !HASH_RE.test(row?.marketId || "") || !isPositiveInteger(row?.chainId)) continue;
    const key = `${row.chainId}:${row.marketId.toLowerCase()}`;
    if (!rootBorrowers.has(key)) rootBorrowers.set(key, []);
    rootBorrowers.get(key).push(row);
  }
  const positions = new Map();
  for (const row of Array.isArray(cache.positions) ? cache.positions : []) {
    if (isPositiveInteger(row?.chainId) && HASH_RE.test(row?.marketId || "") && ADDRESS_RE.test(row?.borrower || "")) {
      positions.set(positionKey(row.chainId, row.marketId, row.borrower), row);
    }
  }
  for (const row of startup?.results?.liquidatablePositions || []) {
    if (HASH_RE.test(row?.marketId || "") && ADDRESS_RE.test(row?.borrower || "")) {
      positions.set(positionKey(row.chainId || 1, row.marketId, row.borrower), row);
    }
  }

  const eligible = cache.markets.filter((market) => chainSet.has(market?.chainId)
    && HASH_RE.test(market?.marketId || "")
    && (!marketSet || marketSet.has(market.marketId.toLowerCase())));
  const selectedMarkets = eligible.slice(0, config.limits.maxMarkets);
  const candidates = [];
  for (const market of selectedMarkets) {
    const key = `${market.chainId}:${market.marketId.toLowerCase()}`;
    const rows = rootBorrowers.get(key) || [];
    const addresses = [...(Array.isArray(market.borrowers) ? market.borrowers : []), ...rows.map((row) => row.borrower)];
    const unique = [...new Set(addresses.filter((address) => ADDRESS_RE.test(address || "")).map((address) => address.toLowerCase()))]
      .slice(0, config.limits.maxPositionsPerMarket);
    for (const borrower of unique) {
      if (candidates.length >= config.limits.maxPositions) break;
      candidates.push({
        chainId: market.chainId,
        chainKey: String(market.chainKey || market.chain || market.chainId).toLowerCase(),
        marketId: market.marketId,
        borrower,
        market,
        cachedPosition: positions.get(positionKey(market.chainId, market.marketId, borrower))
          || rows.find((row) => row.borrower.toLowerCase() === borrower),
      });
    }
    if (candidates.length >= config.limits.maxPositions) break;
  }
  return {
    candidates,
    marketsSelected: selectedMarkets.length,
    marketsEligible: eligible.length,
    truncatedMarkets: Math.max(0, eligible.length - selectedMarkets.length),
    truncatedPositions: candidates.length >= config.limits.maxPositions,
  };
}

function oracleContexts(artifact) {
  const map = new Map();
  for (const row of Array.isArray(artifact?.markets) ? artifact.markets : []) {
    if (isPositiveInteger(row?.chainId) && HASH_RE.test(row?.marketId || "")) {
      map.set(`${row.chainId}:${row.marketId.toLowerCase()}`, row);
    }
  }
  return map;
}

function compactOracleContext(row, capturedAt) {
  if (!row) return null;
  return {
    capturedAt: typeof capturedAt === "string" ? capturedAt : null,
    status: typeof row.status === "string" ? row.status : null,
    feedFrozen: typeof row.conditions?.feedFrozen === "boolean" ? row.conditions.feedFrozen : null,
    referenceAvailable: typeof row.conditions?.referenceAvailable === "boolean" ? row.conditions.referenceAvailable : null,
  };
}

function firstDefined(...values) { return values.find((value) => value !== undefined && value !== null); }

function offlineEvaluator(contexts, oracleArtifact, config) {
  return async (candidate) => {
    const position = candidate.cachedPosition;
    if (!position || firstDefined(position.collateralRaw, position.collateral) === undefined
        || (firstDefined(position.borrowAssetsRaw, position.borrowed) === undefined
          && firstDefined(position.borrowSharesRaw, position.borrowShares) === undefined)) {
      fail("MISSING_CACHED_POSITION_STATE");
    }
    const market = candidate.market;
    const ctx = contexts.get(`${candidate.chainId}:${candidate.marketId.toLowerCase()}`);
    const state = market.marketState || market.state || {};
    const params = market.marketParams || market.params || {};
    const loanToken = firstDefined(params.loanToken, market.loanToken, position.loanToken, ctx?.loanAddress);
    const configuredUsd = loanToken && config.loanUsdPriceByToken?.[loanToken.toLowerCase()];
    const loanUsdPrice = firstDefined(market.loanUsdPrice, ctx?.reference?.loanUsd, configuredUsd);
    return {
      collateralRaw: firstDefined(position.collateralRaw, position.collateral),
      borrowAssetsRaw: firstDefined(position.borrowAssetsRaw, position.borrowed),
      borrowSharesRaw: firstDefined(position.borrowSharesRaw, position.borrowShares),
      totalBorrowAssetsRaw: firstDefined(state.totalBorrowAssetsRaw, state.totalBorrowAssets, market.totalBorrowAssetsRaw),
      totalBorrowSharesRaw: firstDefined(state.totalBorrowSharesRaw, state.totalBorrowShares, market.totalBorrowSharesRaw),
      oraclePriceRaw: firstDefined(position.oraclePriceRaw, market.oraclePriceRaw, ctx?.oraclePrice?.raw),
      lltvRaw: firstDefined(position.lltvRaw, params.lltvRaw, params.lltv, market.lltvRaw, ctx?.lltv),
      loanDecimals: firstDefined(market.loanDecimals, ctx?.loanDecimals),
      loanUsdPrice,
      estimatedGasUsd: Number(config.estimatedGasUsdByChain?.[candidate.chainId] || 0),
      oracleContext: compactOracleContext(ctx, oracleArtifact?.capturedAt),
      valuationSource: ctx?.reference?.loanUsd ? "cached-oracle-context-reference" : "cache",
    };
  };
}

function word(raw, index) {
  if (typeof raw !== "string" || !/^0x[0-9a-f]+$/i.test(raw)) fail("RPC_RESPONSE_INVALID");
  const start = 2 + index * 64;
  if (raw.length < start + 64) fail("RPC_RESPONSE_INVALID");
  return raw.slice(start, start + 64);
}

function addressWord(raw, index) { return `0x${word(raw, index).slice(24)}`.toLowerCase(); }
function encodeAddress(address) { return "0".repeat(24) + address.slice(2).toLowerCase(); }

function rpcEvaluator(contexts, oracleArtifact, config, dependencies = {}) {
  // The endpoint inventory and RPC implementation are intentionally loaded only
  // after the caller has passed the explicit --run-once gate.
  const shared = dependencies.sharedRpc || require("./shared-rpc");
  const resolve = dependencies.resolveRpc || shared.resolveRpc;
  const call = dependencies.rpcCall || shared.rpcCall;
  let rpcRequests = 0;
  const rpcByChain = new Map();
  const marketReads = new Map();
  const marketValuationReads = new Map();

  async function callRpc(rpc, to, data) {
    if (++rpcRequests > config.limits.maxRpcRequests) fail("RPC_BUDGET_EXHAUSTED");
    return call(rpc, "eth_call", [{ to, data }, "latest"], config.limits.rpcTimeoutMs);
  }

  async function checkedCall(transport, to, data) {
    let raw = await callRpc(transport.rpc, to, data);
    if (typeof raw === "string") return raw;
    if (!transport.fallbackAttempted) {
      transport.fallbackAttempted = true;
      const fallback = await resolve(transport.chainId, [], {
        capability: "read", maxCandidates: 16, timeoutMs: config.limits.rpcTimeoutMs,
      });
      if (fallback && fallback !== transport.rpc) {
        transport.rpc = fallback;
        raw = await callRpc(transport.rpc, to, data);
        if (typeof raw === "string") return raw;
      }
    }
    fail("RPC_READ_FAILED");
  }

  async function rpcFor(chainId) {
    if (!rpcByChain.has(chainId)) {
      rpcByChain.set(chainId, Promise.resolve(resolve(chainId, null, {
        capability: "read", maxCandidates: 16, timeoutMs: config.limits.rpcTimeoutMs,
      })).then((rpc) => rpc ? { chainId, rpc, fallbackAttempted: false } : fail("RPC_UNAVAILABLE")));
    }
    return rpcByChain.get(chainId);
  }

  async function readMarket(candidate) {
    const key = `${candidate.chainId}:${candidate.marketId.toLowerCase()}`;
    if (!marketReads.has(key)) marketReads.set(key, (async () => {
      const transport = await rpcFor(candidate.chainId);
      const paramsRaw = await checkedCall(transport, MORPHO, `0x2c3c9157${candidate.marketId.slice(2)}`);
      const stateRaw = await checkedCall(transport, MORPHO, `0x5c60e39a${candidate.marketId.slice(2)}`);
      const params = {
        loanToken: addressWord(paramsRaw, 0), collateralToken: addressWord(paramsRaw, 1),
        oracle: addressWord(paramsRaw, 2), lltvRaw: BigInt(`0x${word(paramsRaw, 4)}`).toString(),
      };
      const state = {
        totalBorrowAssetsRaw: BigInt(`0x${word(stateRaw, 2)}`).toString(),
        totalBorrowSharesRaw: BigInt(`0x${word(stateRaw, 3)}`).toString(),
      };
      return { transport, params, state };
    })());
    return marketReads.get(key);
  }

  async function readMarketValuation(candidate, market) {
    const key = `${candidate.chainId}:${candidate.marketId.toLowerCase()}`;
    if (!marketValuationReads.has(key)) marketValuationReads.set(key, (async () => {
      const oracleRaw = await checkedCall(market.transport, market.params.oracle, "0xa035b1fe");
      const decimalsRaw = await checkedCall(market.transport, market.params.loanToken, "0x313ce567");
      return {
        oraclePriceRaw: BigInt(`0x${word(oracleRaw, 0)}`).toString(),
        loanDecimals: Number(BigInt(`0x${word(decimalsRaw, 0)}`)),
      };
    })());
    return marketValuationReads.get(key);
  }

  const evaluate = async (candidate) => {
    const market = await readMarket(candidate);
    const positionRaw = await checkedCall(
      market.transport,
      MORPHO,
      `0x93c52062${candidate.marketId.slice(2)}${encodeAddress(candidate.borrower)}`,
    );
    const borrowSharesRaw = BigInt(`0x${word(positionRaw, 1)}`).toString();
    if (borrowSharesRaw === "0") return { borrowSharesRaw, ...market.state };
    const valuation = await readMarketValuation(candidate, market);
    const ctx = contexts.get(`${candidate.chainId}:${candidate.marketId.toLowerCase()}`);
    const configuredUsd = config.loanUsdPriceByToken?.[market.params.loanToken];
    const loanUsdPrice = firstDefined(ctx?.reference?.loanUsd, configuredUsd);
    return {
      collateralRaw: BigInt(`0x${word(positionRaw, 2)}`).toString(),
      borrowSharesRaw,
      ...market.state,
      oraclePriceRaw: valuation.oraclePriceRaw,
      lltvRaw: market.params.lltvRaw,
      loanDecimals: valuation.loanDecimals,
      loanUsdPrice,
      estimatedGasUsd: Number(config.estimatedGasUsdByChain?.[candidate.chainId] || 0),
      oracleContext: compactOracleContext(ctx, oracleArtifact?.capturedAt),
      valuationSource: ctx?.reference?.loanUsd ? "rpc-state-plus-cached-reference" : "rpc-state",
    };
  };
  evaluate.rpcRequestCount = () => rpcRequests;
  return evaluate;
}

function assertSanitized(value) {
  const text = JSON.stringify(value);
  const forbidden = [
    /https?:\/\//i,
    /rpc_endpoints\.txt/i,
    /authorization["']?\s*:/i,
    /(?:api[_-]?key|private[_-]?key|mnemonic|secret)["']?\s*:/i,
    /[?&](?:token|key|api_key)=/i,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) fail("OUTPUT_SANITIZATION_FAILED");
  return true;
}

function atomicPublish(file, artifact, maxBytes) {
  assertSanitized(artifact);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  if (bytes.length > maxBytes) fail("OUTPUT_SIZE_EXCEEDED");
  const temporary = `${file}.tmp-${process.pid}-${process.hrtime.bigint().toString(16)}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

async function run(options = {}) {
  const configPath = options.configPath || DEFAULTS.config;
  const cachePath = options.cachePath || DEFAULTS.cache;
  const startupPath = options.startupPath || DEFAULTS.startup;
  const oraclePath = options.oraclePath || DEFAULTS.oracle;
  const outputPath = options.outputPath || DEFAULTS.output;
  const config = validateConfig(options.config || readJson(configPath));
  const cache = options.cache || readJson(cachePath);
  const startup = options.startup || readJson(startupPath);
  const oracle = options.oracle || readJson(oraclePath);
  const prepared = prepareCandidates(cache, startup, config);
  const contexts = oracleContexts(oracle);
  const evaluator = options.evaluator || (options.runOnce
    ? rpcEvaluator(contexts, oracle, config, options.dependencies)
    : offlineEvaluator(contexts, oracle, config));
  const scanned = await scanCandidates(prepared.candidates, evaluator, config);
  const artifact = {
    schema: SCHEMA,
    generatedAt: (options.now ? new Date(options.now) : new Date()).toISOString(),
    source: {
      mode: options.runOnce ? "run-once-read-only-rpc" : "offline-cache",
      networkReadsAllowed: options.runOnce === true,
      cache: { path: "reports/monitor/morpho-ws-cache.json", updatedAt: cache.updatedAt || null },
      startupScan: {
        path: "reports/monitor/morpho-liquidatable-startup.json",
        generatedAt: startup.generatedAt || null,
        classification: startup.classification || null,
      },
      oracleContext: {
        path: "reports/raw/fast/morpho-frozen-oracle-status.json",
        capturedAt: oracle.capturedAt || null,
      },
      config: "tools/protocol-loss-scan-config.json",
    },
    marketsScanned: prepared.marketsSelected,
    positionsScanned: prepared.candidates.length,
    flagged: scanned.flagged,
    stats: {
      ...scanned.stats,
      marketsEligible: prepared.marketsEligible,
      marketsTruncatedByCap: prepared.truncatedMarkets,
      positionsTruncatedByCap: prepared.truncatedPositions,
      rpcRequests: typeof evaluator.rpcRequestCount === "function" ? evaluator.rpcRequestCount() : 0,
      cacheHasCurrentPositionCollection: Array.isArray(cache.positions),
    },
    flagSemantics: {
      PROTOCOL_LOSS_LIQUIDATION: "exact raw-unit residual bad debt exists and valued USD thresholds pass",
      UNVALUED_PROTOCOL_LOSS_CANDIDATE: "exact raw-unit residual bad debt exists but trusted USD valuation is unavailable",
      UNDERWATER: "exact Morpho max-borrow raw amount is below exact virtual-offset debt raw amount",
      residualShortfallRaw: "Morpho post-full-seizure badDebtAssets calculation in raw loan-token units",
      routePositive: "n/a: protocol-loss classification is not a liquidator profit or executable-route claim",
    },
    safety: {
      readOnly: true,
      offlineDefault: true,
      rpcRequiresRunOnce: true,
      signing: false,
      transactions: false,
      broadcasting: false,
      stateMutations: false,
      endpointValuesStored: false,
      endpointMaterialInArgv: false,
      perPositionFailClosed: true,
      bounded: true,
      liquidatorEconomicsAreEstimatesOnly: true,
      netProfitClaimed: false,
    },
  };
  assertSanitized(artifact);
  if (options.write !== false) atomicPublish(outputPath, artifact, config.limits.maxOutputBytes);
  return artifact;
}

async function main() {
  try {
    const cli = parseCli(process.argv.slice(2));
    const artifact = await run(cli);
    process.stdout.write(`${JSON.stringify({
      schema: artifact.schema,
      mode: artifact.source.mode,
      marketsScanned: artifact.marketsScanned,
      positionsScanned: artifact.positionsScanned,
      flagged: artifact.flagged.length,
      failedClosed: artifact.stats.positionsFailedClosed,
    })}\n`);
  } catch (error) {
    process.stderr.write(`protocol-loss-liquidation-scan failed: ${safeCode(error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  CONFIG_SCHEMA,
  SCHEMA,
  ScanFailure,
  assertSanitized,
  atomicPublish,
  computePosition,
  offlineEvaluator,
  parseCli,
  prepareCandidates,
  run,
  scanCandidates,
  validateConfig,
};
