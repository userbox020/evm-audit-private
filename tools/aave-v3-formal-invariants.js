#!/usr/bin/env node
// aave-v3-formal-invariants.js
// Read-only bounded Aave V3 invariant scanner for multichain formal checks.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "aave-v3-formal-invariants.json");
const OUT_SUMMARY = path.join(WORKSPACE, "reports", "raw", "aave-v3-formal-invariants-summary.md");

const ZERO_ADDRESS = ethers.ZeroAddress;
const ONE_RAY = 10n ** 27n;
const MAX_36_BITS = (1n << 36n) - 1n;
const STALE_SECONDS = 24 * 60 * 60;

const AAVE_POOLS = {
  1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  10: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  137: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  43114: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  100: "0xb50201558B00496A145fE76f7424749556E326D8",
  534352: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe",
  56: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
};

const CHAIN_NAMES = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum",
  10: "Optimism",
  137: "Polygon",
  43114: "Avalanche",
  100: "Gnosis",
  534352: "Scroll",
  56: "BSC",
};

const HOT_BORROWER = "0x1a557354c5b8d7df38ea914209e416dc7065b158";

function emptyChainState(chainId, chainName, pool, rpc) {
  return {
    chainId,
    chain: chainName,
    pool,
    rpc,
    rpcResolved: Boolean(rpc),
    blockNumber: null,
    blockTimestamp: null,
    blockTag: null,
    reservesRequested: 0,
    reservesScanned: 0,
    oracle: { addressesProvider: null, priceOracle: null, sentinel: null },
    sentinelState: { hasCode: false, borrowAllowed: null, liquidationAllowed: null, error: null },
    eModeCategories: new Set(),
    oracleSupportsPrice: null,
    oracleSupportsSource: null,
    oracleSources: new Map(),
    findings: {
      reserve: [],
      emode: [],
      user: [],
      chain: [],
    },
    errors: [],
    userChecks: null,
  };
}

const POOL = new ethers.Interface([
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getReservesList() view returns (address[])",
  "function getReserveData(address) view returns (tuple(uint256) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getEModeCategoryData(uint8) view returns (tuple(uint16,uint16,uint16,address,string))",
]);

const ADDR_PROVIDER = new ethers.Interface([
  "function getPriceOracle() view returns (address)",
  "function getPriceOracleSentinel() view returns (address)",
]);

const ORACLE = new ethers.Interface([
  "function getAssetPrice(address) view returns (uint256)",
  "function getSourceOfAsset(address) view returns (address)",
]);

const ORACLE_SENTINEL = new ethers.Interface([
  "function isBorrowAllowed() view returns (bool)",
  "function isLiquidationAllowed() view returns (bool)",
]);

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

const AGGREGATOR = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

const tokenCache = new Map();

const CALL_TIMEOUT_MS = 12_000;

function normalizeAddress(value) {
  try {
    if (!value || typeof value !== "string") return null;
    const normalized = ethers.getAddress(value);
    return normalized;
  } catch (_) {
    return null;
  }
}

function splitWords(raw) {
  if (!raw || raw === "0x") return [];
  const hex = String(raw).replace(/^0x/i, "");
  return hex.length ? hex.match(/.{1,64}/g) || [] : [];
}

function wordAt(raw, index) {
  const words = splitWords(raw);
  return words[index] ? `0x${words[index]}` : null;
}

function addressFromWord(raw, index) {
  const w = wordAt(raw, index);
  if (!w) return null;
  return normalizeAddress(`0x${String(w).replace(/^0x/i, "").slice(-40)}`);
}

function safeToNumber(value, fallback = null) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return fallback;
  return Number(value);
}

function toFloat(raw, decimals) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (!Number.isFinite(Number(decimals))) return null;
  try {
    return Number(ethers.formatUnits(BigInt(raw), Number(decimals)));
  } catch (_) {
    return null;
  }
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function resultArray(value) {
  try {
    return Array.from(value || []);
  } catch (_) {
    return [];
  }
}

function maxSeverity(a, b) {
  const order = { info: 0, watch: 1, violation: 2, "route-positive": 3 };
  return order[a] >= order[b] ? a : b;
}

function makeFinding({ chain, chainId, reserve, symbol, invariant, details, severity = "info", routePositive = false }) {
  return {
    chain,
    chainId,
    reserve,
    symbol,
    invariant,
    details,
    severity,
    routePositive,
  };
}

async function safeCall(rpc, to, iface, name, args = [], blockTag = "latest") {
  const data = iface.encodeFunctionData(name, args);
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to, data }, blockTag], CALL_TIMEOUT_MS);
    if (!raw || raw === "0x") return { ok: false, error: "empty-response", raw: null, value: null };
    try {
      const value = iface.decodeFunctionResult(name, raw);
      return { ok: true, raw, value };
    } catch (decodeErr) {
      return { ok: false, error: `decode-${String(decodeErr.message || decodeErr)}`, raw, value: null };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e), raw: null, value: null };
  }
}

async function safeGetCode(rpc, address, blockTag = "latest") {
  try {
    const raw = await rpcCall(rpc, "eth_getCode", [address, blockTag], CALL_TIMEOUT_MS);
    return { ok: true, code: raw || "0x" };
  } catch (e) {
    return { ok: false, code: "0x", error: String(e?.message || e) };
  }
}

async function safeGetBlock(rpc, blockTag) {
  try {
    const raw = await rpcCall(rpc, "eth_getBlockByNumber", [blockTag, false], CALL_TIMEOUT_MS);
    return { ok: true, block: raw || null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function parseReserveConfig(wordValue) {
  const cfg = BigInt(wordValue);
  const mask16 = 0xffffn;
  const mask36 = MAX_36_BITS;
  const mask40 = (1n << 40n) - 1n;
  const mask8 = 0xffn;

  return {
    raw: `0x${cfg.toString(16).padStart(64, "0")}`,
    ltvBps: Number(cfg & mask16),
    liquidationThresholdBps: Number((cfg >> 16n) & mask16),
    liquidationBonusBps: Number((cfg >> 32n) & mask16),
    decimals: Number((cfg >> 48n) & mask8),
    active: ((cfg >> 56n) & 1n) === 1n,
    frozen: ((cfg >> 57n) & 1n) === 1n,
    borrowingEnabled: ((cfg >> 58n) & 1n) === 1n,
    stableBorrowingEnabled: ((cfg >> 59n) & 1n) === 1n,
    paused: ((cfg >> 60n) & 1n) === 1n,
    borrowableInIsolation: ((cfg >> 61n) & 1n) === 1n,
    siloedBorrowing: ((cfg >> 62n) & 1n) === 1n,
    flashloanEnabled: ((cfg >> 63n) & 1n) === 1n,
    reserveFactorBps: Number((cfg >> 64n) & 0xffffn),
    borrowCapWholeTokens: Number((cfg >> 80n) & mask36),
    supplyCapWholeTokens: Number((cfg >> 116n) & mask36),
    liquidationProtocolFeeBps: Number((cfg >> 152n) & 0xffffn),
    eModeCategoryId: Number((cfg >> 168n) & 0xffn),
    unbackedMintCapWholeTokens: Number((cfg >> 176n) & mask36),
    debtCeilingWholeTokens: Number((cfg >> 212n) & mask40),
  };
};

function parseReserveData(raw) {
  const w = splitWords(raw);
  if (w.length < 15) return null;

  const cfgWord = BigInt(`0x${w[0]}`);
  return {
    configWord: cfgWord,
    liquidityIndex: BigInt(`0x${w[1]}`),
    variableBorrowIndex: BigInt(`0x${w[3]}`),
    lastUpdateTimestamp: Number(BigInt(`0x${w[6]}`)),
    aTokenAddress: addressFromWord(raw, 8),
    stableDebtTokenAddress: addressFromWord(raw, 9),
    variableDebtTokenAddress: addressFromWord(raw, 10),
  };
}

function convertRawToWhole(reserveDecimals, raw, tokenDecimals) {
  if (!raw || !Number.isFinite(reserveDecimals) || !Number.isFinite(tokenDecimals)) return null;
  try {
    let value = BigInt(raw);
    if (Number(tokenDecimals) === Number(reserveDecimals)) return value;
    if (Number(tokenDecimals) < Number(reserveDecimals)) {
      value *= 10n ** BigInt(Number(reserveDecimals) - Number(tokenDecimals));
    } else {
      value /= 10n ** BigInt(Number(tokenDecimals) - Number(reserveDecimals));
    }
    return value;
  } catch (_) {
    return null;
  }
}

async function inspectToken(rpc, address, blockTag) {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  const key = `${normalized.toLowerCase()}@${blockTag}`;
  if (tokenCache.has(key)) return tokenCache.get(key);

  const [codeRes, symbolRes, decimalsRes, totalSupplyRes] = await Promise.all([
    safeGetCode(rpc, normalized, blockTag),
    safeCall(rpc, normalized, ERC20, "symbol", [], blockTag),
    safeCall(rpc, normalized, ERC20, "decimals", [], blockTag),
    safeCall(rpc, normalized, ERC20, "totalSupply", [], blockTag),
  ]);

  const result = {
    address: normalized,
    hasCode: !!(codeRes.ok && codeRes.code && codeRes.code !== "0x"),
    code: codeRes.ok ? codeRes.code : null,
    symbol: symbolRes.ok ? String(symbolRes.value[0] || "") : null,
    decimals: decimalsRes.ok ? Number(decimalsRes.value[0]) : null,
    totalSupplyRaw: totalSupplyRes.ok ? BigInt(totalSupplyRes.value[0]) : null,
    errors: {
      code: codeRes.ok ? null : codeRes.error,
      symbol: symbolRes.ok ? null : symbolRes.error,
      decimals: decimalsRes.ok ? null : decimalsRes.error,
      totalSupply: totalSupplyRes.ok ? null : totalSupplyRes.error,
    },
  };

  tokenCache.set(key, result);
  return result;
}

async function getBlockSnapshot(rpc) {
  const latestHexRes = await rpcCall(rpc, "eth_blockNumber", [], 7000);
  if (!latestHexRes) return null;
  const blockNumber = Number(BigInt(latestHexRes));
  const blockTag = `0x${blockNumber.toString(16)}`;
  const blockRes = await safeGetBlock(rpc, blockTag);
  if (!blockRes.ok || !blockRes.block) return { blockNumber, blockTag, block: null, timestamp: null };
  const timestamp = Number(BigInt(blockRes.block.timestamp || "0x0"));
  return { blockNumber, blockTag, block: blockRes.block, timestamp };
}

function evaluateReserveInvariants(ctx, data, config, tokenMeta, aTokenMeta, stableDebtMeta, variableDebtMeta, blockTs) {
  const findings = [];
  const symbol = tokenMeta?.symbol || "(unknown)";

  if (config.ltvBps > config.liquidationThresholdBps && config.liquidationThresholdBps > 0) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve: ctx.reserve,
      symbol,
      invariant: "ltv<=liquidationThreshold",
      severity: "violation",
      details: { ltvBps: config.ltvBps, liquidationThresholdBps: config.liquidationThresholdBps },
    }));
  }

  if (config.liquidationThresholdBps === 0 && config.ltvBps !== 0) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve: ctx.reserve,
      symbol,
      invariant: "liquidationThreshold-is-zero",
      severity: "watch",
      details: { ltvBps: config.ltvBps, liquidationThresholdBps: config.liquidationThresholdBps, note: "non-zero LTV with zero liquidationThreshold" },
    }));
  }

  if (config.liquidationThresholdBps > 0 && config.liquidationBonusBps < 10000) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve: ctx.reserve,
      symbol,
      invariant: "liquidationBonus-minimum",
      severity: "violation",
      details: { liquidationThresholdBps: config.liquidationThresholdBps, liquidationBonusBps: config.liquidationBonusBps },
    }));
  }

  if (config.liquidationProtocolFeeBps > 10000) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve: ctx.reserve,
      symbol,
      invariant: "liquidationProtocolFee<=10000",
      severity: "violation",
      details: { liquidationProtocolFeeBps: config.liquidationProtocolFeeBps },
    }));
  }

  if (config.reserveFactorBps > 10000) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve: ctx.reserve,
      symbol,
      invariant: "reserveFactor<=10000",
      severity: "violation",
      details: { reserveFactorBps: config.reserveFactorBps },
    }));
  }

  const cfgDecimalsOk = Number.isInteger(config.decimals) && config.decimals >= 0 && config.decimals <= 255;
  if (!cfgDecimalsOk) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve: ctx.reserve,
      symbol,
      invariant: "config-decimals-valid",
      severity: "violation",
      details: { configDecimals: config.decimals },
    }));
  }

  if (tokenMeta?.decimals !== null && tokenMeta.decimals !== undefined && tokenMeta.decimals !== config.decimals) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve: ctx.reserve,
      symbol,
      invariant: "reserve-decimals-consistency",
      severity: "watch",
      details: { configDecimals: config.decimals, onchainDecimals: tokenMeta.decimals },
    }));
  }

  for (const row of [
    { key: "reserve", meta: tokenMeta },
    { key: "aToken", meta: aTokenMeta },
    { key: "stableDebtToken", meta: stableDebtMeta },
    { key: "variableDebtToken", meta: variableDebtMeta },
  ]) {
    const address = normalizeAddress(row.meta?.address || "0x0000000000000000000000000000000000000000");
    if (!address || address === ZERO_ADDRESS) continue;
    if (!row.meta?.hasCode) {
      findings.push(makeFinding({
        chain: ctx.chain,
        chainId: ctx.chainId,
        reserve: ctx.reserve,
        symbol,
        invariant: `${row.key}-bytecode-present`,
        severity: config.active ? "violation" : "watch",
        details: { component: row.key, address, note: "token/debt wrapper missing runtime bytecode" },
      }));
    }
  }

  if (config.active) {
    if (data.liquidityIndex === 0n) {
      findings.push(makeFinding({
        chain: ctx.chain,
        chainId: ctx.chainId,
        reserve: ctx.reserve,
        symbol,
        invariant: "liquidityIndex-active-nonzero",
        severity: "violation",
        details: { liquidityIndex: data.liquidityIndex.toString() },
      }));
    } else if (data.liquidityIndex < ONE_RAY) {
      findings.push(makeFinding({
        chain: ctx.chain,
        chainId: ctx.chainId,
        reserve: ctx.reserve,
        symbol,
        invariant: "liquidityIndex>=1e27",
        severity: "violation",
        details: { liquidityIndex: data.liquidityIndex.toString() },
      }));
    }

    if (data.variableBorrowIndex === 0n) {
      findings.push(makeFinding({
        chain: ctx.chain,
        chainId: ctx.chainId,
        reserve: ctx.reserve,
        symbol,
        invariant: "variableBorrowIndex-active-nonzero",
        severity: "violation",
        details: { variableBorrowIndex: data.variableBorrowIndex.toString() },
      }));
    } else if (data.variableBorrowIndex < ONE_RAY) {
      findings.push(makeFinding({
        chain: ctx.chain,
        chainId: ctx.chainId,
        reserve: ctx.reserve,
        symbol,
        invariant: "variableBorrowIndex>=1e27",
        severity: "violation",
        details: { variableBorrowIndex: data.variableBorrowIndex.toString() },
      }));
    }
  } else if (data.liquidityIndex === 0n || data.variableBorrowIndex === 0n) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve: ctx.reserve,
      symbol,
      invariant: "inactive-index-state",
      severity: "info",
      details: {
        active: false,
        liquidityIndex: data.liquidityIndex.toString(),
        variableBorrowIndex: data.variableBorrowIndex.toString(),
      },
    }));
  }

  if (Number.isFinite(blockTs)) {
    if (data.lastUpdateTimestamp > blockTs) {
      findings.push(makeFinding({
        chain: ctx.chain,
        chainId: ctx.chainId,
        reserve: ctx.reserve,
        symbol,
        invariant: "lastUpdateTimestamp-not-future",
        severity: "violation",
        details: { lastUpdateTimestamp: data.lastUpdateTimestamp, blockTimestamp: blockTs },
      }));
    }
  }

  const reserveDecimals = Number.isFinite(tokenMeta?.decimals) ? tokenMeta.decimals : config.decimals;
  if (config.supplyCapWholeTokens > 0 && aTokenMeta?.totalSupplyRaw !== null) {
    const supplyUnits = toFloat(aTokenMeta.totalSupplyRaw, reserveDecimals);
    if (supplyUnits !== null && supplyUnits > config.supplyCapWholeTokens) {
      findings.push(makeFinding({
        chain: ctx.chain,
        chainId: ctx.chainId,
        reserve: ctx.reserve,
        symbol,
        invariant: "supplyCap-boundary",
        severity: "watch",
        details: {
          supplyCapWholeTokens: config.supplyCapWholeTokens,
          observedSupplyUnits: supplyUnits,
          aToken: aTokenMeta.address,
          note: "Cap can be reduced below current supply by governance; watch-only unless a new extraction path exists.",
        },
      }));
    }
  }

  if (config.borrowCapWholeTokens > 0) {
    const debtTokensDecimals = Number.isFinite(stableDebtMeta?.decimals) ? stableDebtMeta.decimals : reserveDecimals;
    const stableDebt = stableDebtMeta?.totalSupplyRaw ? toFloat(stableDebtMeta.totalSupplyRaw, debtTokensDecimals) : null;
    const variableDebt = variableDebtMeta?.totalSupplyRaw ? toFloat(variableDebtMeta.totalSupplyRaw, debtTokensDecimals) : null;
    const debtTotalRaw = stableDebt + variableDebt;
    if (Number.isFinite(stableDebt) || Number.isFinite(variableDebt)) {
      const totalBorrowableUnits = Number.isFinite(stableDebt) && Number.isFinite(variableDebt)
        ? stableDebt + variableDebt
        : Number.isFinite(stableDebt)
          ? stableDebt
          : variableDebt;
      if (totalBorrowableUnits > config.borrowCapWholeTokens) {
        findings.push(makeFinding({
          chain: ctx.chain,
          chainId: ctx.chainId,
          reserve: ctx.reserve,
          symbol,
          invariant: "borrowCap-boundary",
          severity: "watch",
          details: {
            borrowCapWholeTokens: config.borrowCapWholeTokens,
            observedBorrowUnits: totalBorrowableUnits,
            stableDebtToken: stableDebtMeta?.address || null,
            variableDebtToken: variableDebtMeta?.address || null,
            note: "Cap can be reduced below current debt by governance; watch-only unless a new borrow bypass exists.",
          },
        }));
      }
    }
  }

  if (config.liquidationThresholdBps > 10000 || config.ltvBps > 10000 || config.reserveFactorBps > 10000 || config.liquidationProtocolFeeBps > 10000) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve: ctx.reserve,
      symbol,
      invariant: "bps-upper-bound-10000",
      severity: "violation",
      details: {
        ltvBps: config.ltvBps,
        liquidationThresholdBps: config.liquidationThresholdBps,
        reserveFactorBps: config.reserveFactorBps,
        liquidationProtocolFeeBps: config.liquidationProtocolFeeBps,
      },
    }));
  }

  return findings;
}

async function evaluateOracleInvariants(ctx, reserve, symbol, oracleAddress, blockTs, blockTag, chainState) {
  const findings = [];
  if (!oracleAddress || oracleAddress === ZERO_ADDRESS) return findings;

  // Aave oracle asset price.
  const priceRes = await safeCall(ctx.rpc, oracleAddress, ORACLE, "getAssetPrice", [reserve], blockTag);
  if (!priceRes.ok) {
    if (chainState.oracleSupportsPrice === null) chainState.oracleSupportsPrice = false;
    if (chainState.oracleSupportsPrice === false) {
      findings.push(makeFinding({
        chain: ctx.chain,
        chainId: ctx.chainId,
        reserve,
        symbol,
        invariant: "oracle-getAssetPrice-availability",
        severity: "info",
        details: { oracle: oracleAddress, error: priceRes.error },
      }));
      chainState.oracleSupportsPrice = false;
    }
    return findings;
  }

  chainState.oracleSupportsPrice = true;
  const oraclePriceRaw = BigInt(priceRes.value[0]);
  const oraclePrice = toFloat(oraclePriceRaw, 8);

  if (!(oraclePriceRaw > 0n)) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve,
      symbol,
      invariant: "oracle-asset-price-positive",
      severity: "violation",
      details: { oracle: oracleAddress, oraclePriceRaw: oraclePriceRaw.toString(), oraclePrice },
    }));
  }

  const sourceRes = await safeCall(ctx.rpc, oracleAddress, ORACLE, "getSourceOfAsset", [reserve], blockTag);
  if (!sourceRes.ok) {
    if (chainState.oracleSupportsSource === null) {
      chainState.oracleSupportsSource = false;
      findings.push(makeFinding({
        chain: ctx.chain,
        chainId: ctx.chainId,
        reserve,
        symbol,
        invariant: "oracle-source-availability",
        severity: "info",
        details: { oracle: oracleAddress, error: sourceRes.error },
      }));
    }
    return findings;
  }

  chainState.oracleSupportsSource = true;
  const source = normalizeAddress(sourceRes.value[0]);
  if (!source || source === ZERO_ADDRESS) return findings;

  const sourceMeta = await inspectToken(ctx.rpc, source, blockTag);
  if (!sourceMeta?.hasCode) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve,
      symbol,
      invariant: "oracle-source-code-present",
      severity: "violation",
      details: { oracle: oracleAddress, source },
    }));
    return findings;
  }

  if (!chainState.oracleSources.has(source)) {
    const roundRes = await safeCall(ctx.rpc, source, AGGREGATOR, "latestRoundData", [], blockTag);
    if (roundRes.ok) {
      const roundData = {
        roundId: BigInt(roundRes.value[0]),
        answer: BigInt(roundRes.value[1]),
        startedAt: Number(BigInt(roundRes.value[2])),
        updatedAt: Number(BigInt(roundRes.value[3])),
        answeredInRound: BigInt(roundRes.value[4]),
      };

      const decimalRes = await safeCall(ctx.rpc, source, AGGREGATOR, "decimals", [], blockTag);
      const feedDecimals = decimalRes.ok ? Number(decimalRes.value[0]) : 8;
      chainState.oracleSources.set(source, { roundRes: roundRes.raw, latestRoundData: roundData, decimals: feedDecimals, supportsLatestRoundData: true, parsed: true });
    } else {
      chainState.oracleSources.set(source, { latestRoundData: null, supportsLatestRoundData: false, decimals: 8, parsed: false });
    }
  }

  const sourceState = chainState.oracleSources.get(source);
  if (!sourceState?.parsed || !sourceState?.supportsLatestRoundData) {
    return findings;
  }

  const { latestRoundData, decimals: feedDecimals } = sourceState;
  if (!latestRoundData) return findings;

  if (latestRoundData.answer <= 0n) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve,
      symbol,
      invariant: "aggregator-answer-positive",
      severity: "violation",
      details: {
        source,
        answerRaw: latestRoundData.answer.toString(),
        feedDecimals,
      },
    }));
  }

  if (latestRoundData.answeredInRound < latestRoundData.roundId) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve,
      symbol,
      invariant: "aggregator-answeredInRound-order",
      severity: "violation",
      details: { source, roundId: latestRoundData.roundId.toString(), answeredInRound: latestRoundData.answeredInRound.toString() },
    }));
  }

  if (latestRoundData.updatedAt <= 0) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve,
      symbol,
      invariant: "aggregator-updatedAt-positive",
      severity: "watch",
      details: { source, updatedAt: latestRoundData.updatedAt },
    }));
  }

  if (Number.isFinite(blockTs) && latestRoundData.updatedAt > blockTs) {
    findings.push(makeFinding({
      chain: ctx.chain,
      chainId: ctx.chainId,
      reserve,
      symbol,
      invariant: "aggregator-updatedAt-not-future",
      severity: "violation",
      details: { source, updatedAt: latestRoundData.updatedAt, blockTimestamp: blockTs },
    }));
  }

  if (Number.isFinite(blockTs)) {
    const age = blockTs - latestRoundData.updatedAt;
    if (Number.isFinite(age) && age >= 0) {
      if (age > STALE_SECONDS && (oraclePrice === null || oraclePrice > 0)) {
        findings.push(makeFinding({
          chain: ctx.chain,
          chainId: ctx.chainId,
          reserve,
          symbol,
          invariant: "aggregator-stale-age",
          severity: "watch",
          details: {
            source,
            ageSeconds: age,
            stale: age > STALE_SECONDS,
            oraclePrice,
          },
        }));
      }
    }
  }

  return findings;
}

async function scanEmodeCategories(rpc, chainState, blockTag) {
  const seen = new Map();
  for (const id of chainState.eModeCategories) {
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.set(id, true);

    const raw = await safeCall(rpc, chainState.pool, POOL, "getEModeCategoryData", [id], blockTag);
    if (!raw.ok) {
      chainState.findings.eMode.push(makeFinding({
        chain: chainState.chain,
        chainId: chainState.chainId,
        reserve: `eModeCategory:${id}`,
        symbol: null,
        invariant: "emode-data-availability",
        severity: "info",
        details: { category: id, error: raw.error },
      }));
      continue;
    }

    const root = resultArray(raw.value);
    const emodeRaw = root.length === 1 && root[0] && typeof root[0] === "object" ? resultArray(root[0]) : root;
    const ltvBps = Number(emodeRaw[0]);
    const liquidationThresholdBps = Number(emodeRaw[1]);
    const liquidationBonusBps = Number(emodeRaw[2]);
    const priceSource = normalizeAddress(emodeRaw[3]);

    if (Number.isFinite(ltvBps) && Number.isFinite(liquidationThresholdBps) && ltvBps > liquidationThresholdBps) {
      chainState.findings.eMode.push(makeFinding({
        chain: chainState.chain,
        chainId: chainState.chainId,
        reserve: `eModeCategory:${id}`,
        symbol: null,
        invariant: "emode-ltv-le-threshold",
        severity: "violation",
        details: { category: id, ltvBps, liquidationThresholdBps },
      }));
    }

    if (Number.isFinite(liquidationThresholdBps) && (liquidationThresholdBps < 0 || liquidationThresholdBps > 10000)) {
      chainState.findings.eMode.push(makeFinding({
        chain: chainState.chain,
        chainId: chainState.chainId,
        reserve: `eModeCategory:${id}`,
        symbol: null,
        invariant: "emode-threshold-upper-bound",
        severity: "violation",
        details: { category: id, liquidationThresholdBps },
      }));
    }

    if (liquidationBonusBps < 10000) {
      chainState.findings.eMode.push(makeFinding({
        chain: chainState.chain,
        chainId: chainState.chainId,
        reserve: `eModeCategory:${id}`,
        symbol: null,
        invariant: "emode-bonus-minimum",
        severity: "violation",
        details: { category: id, liquidationBonusBps },
      }));
    }

    if (priceSource && priceSource !== ZERO_ADDRESS) {
      const sourceCode = await safeGetCode(rpc, priceSource, blockTag);
      if (!sourceCode.ok || !sourceCode.code || sourceCode.code === "0x") {
        chainState.findings.eMode.push(makeFinding({
          chain: chainState.chain,
          chainId: chainState.chainId,
          reserve: `eModeCategory:${id}`,
          symbol: null,
          invariant: "emode-priceSource-code-presence",
          severity: "violation",
          details: { category: id, priceSource },
        }));
      }
    }
  }
}

function buildUserBlockerCheck(sentinel, hf) {
  if (!sentinel) {
    return { routePositive: false, watch: true, blocker: "Oracle sentinel unavailable; cannot validate liquidation permission." };
  }
  if (sentinel.liquidationAllowed === false) {
    return { routePositive: false, watch: true, blocker: "Oracle sentinel returns isLiquidationAllowed()=false (blocked route)." };
  }
  if (sentinel.borrowAllowed === false) {
    return { routePositive: false, watch: true, blocker: "Oracle sentinel returns isBorrowAllowed()=false (potential route block)." };
  }
  return { routePositive: hf < 1, watch: hf >= 1, blocker: hf < 1 ? null : "HF>=1; watch-only borrower profile." };
}

async function scanUserChecks(chainState, blockTag) {
  if (chainState.chainId !== 1) return null;
  const userRes = await safeCall(chainState.rpc, chainState.pool, POOL, "getUserAccountData", [HOT_BORROWER], blockTag);
  if (!userRes.ok) {
    return {
      chainId: chainState.chainId,
      chain: chainState.chain,
      user: HOT_BORROWER,
      error: userRes.error,
      healthFactor: null,
      totalCollateralUsd: null,
      totalDebtUsd: null,
      liquidatable: null,
      routePositive: false,
    };
  }

  const [totalCollateralRaw, totalDebtRaw, availableBorrowsRaw, ltRaw, ltvRaw, healthFactorRaw] = userRes.value;
  const totalCollateralUsd = toFloat(totalCollateralRaw, 8);
  const totalDebtUsd = toFloat(totalDebtRaw, 8);
  const availableBorrowsUsd = toFloat(availableBorrowsRaw, 8);
  const healthFactor = toFloat(healthFactorRaw, 18);
  const liquidatable = Number.isFinite(healthFactor) ? healthFactor < 1 : null;

  const blocker = buildUserBlockerCheck(chainState.sentinelState, Number.isFinite(healthFactor) ? healthFactor : null);
  const routePositive = !!(Number.isFinite(healthFactor) && healthFactor < 1 && blocker.routePositive);

  const userChecks = {
    chainId: chainState.chainId,
    chain: chainState.chain,
    user: HOT_BORROWER,
    totalCollateralUsd,
    totalDebtUsd,
    availableBorrowsUsd,
    healthFactor,
    liquidatable,
    routePositive,
    liquidationThresholdBps: Number(ltRaw || 0),
    ltvBps: Number(ltvRaw || 0),
    sentinel: chainState.sentinelState,
    routeBlocker: blocker.blocker,
  };

  const finding = {
    chain: chainState.chain,
    chainId: chainState.chainId,
    reserve: HOT_BORROWER,
    symbol: "hotBorrower",
    invariant: "user-healthFactor",
    severity: routePositive ? "route-positive" : (liquidatable ? "watch" : "info"),
    routePositive,
    details: {
      healthFactor,
      liquidatable,
      totalCollateralUsd,
      totalDebtUsd,
      availableBorrowsUsd,
      blocker: blocker.blocker,
      sentinel: chainState.sentinelState,
    },
  };
  chainState.findings.user = [finding];

  return userChecks;
}

async function scanChain(chainId, chainName, rpc) {
  const chainState = emptyChainState(chainId, chainName, AAVE_POOLS[chainId], rpc);

  if (!rpc) {
    chainState.errors.push("No RPC resolved");
    return chainState;
  }

  const snapshot = await getBlockSnapshot(rpc);
  if (!snapshot) {
    chainState.errors.push("Failed to read current block");
    return chainState;
  }

  chainState.blockNumber = snapshot.blockNumber;
  chainState.blockTimestamp = snapshot.timestamp;
  chainState.blockTag = snapshot.blockTag;

  const providerRaw = await safeCall(rpc, chainState.pool, POOL, "ADDRESSES_PROVIDER", [], chainState.blockTag);
  if (!providerRaw.ok) {
    chainState.errors.push("ADDRESSES_PROVIDER() call failed");
  } else {
    chainState.oracle.addressesProvider = normalizeAddress(providerRaw.value[0]);
    const providerAddress = chainState.oracle.addressesProvider;
    if (providerAddress && providerAddress !== ZERO_ADDRESS) {
      const priceOracleRes = await safeCall(rpc, providerAddress, ADDR_PROVIDER, "getPriceOracle", [], chainState.blockTag);
      if (priceOracleRes.ok) {
        chainState.oracle.priceOracle = normalizeAddress(priceOracleRes.value[0]);
      }

      const sentinelRes = await safeCall(rpc, providerAddress, ADDR_PROVIDER, "getPriceOracleSentinel", [], chainState.blockTag);
      if (sentinelRes.ok) {
        const sentinel = normalizeAddress(sentinelRes.value[0]);
        chainState.oracle.sentinel = sentinel;
        if (sentinel && sentinel !== ZERO_ADDRESS) {
          const sentinelCode = await safeGetCode(rpc, sentinel, chainState.blockTag);
          chainState.sentinelState.hasCode = Boolean(sentinelCode.ok && sentinelCode.code && sentinelCode.code !== "0x");
          if (chainState.sentinelState.hasCode) {
            const borrowAllowed = await safeCall(rpc, sentinel, ORACLE_SENTINEL, "isBorrowAllowed", [], chainState.blockTag);
            const liquidationAllowed = await safeCall(rpc, sentinel, ORACLE_SENTINEL, "isLiquidationAllowed", [], chainState.blockTag);
            chainState.sentinelState.borrowAllowed = borrowAllowed.ok ? Boolean(borrowAllowed.value[0]) : null;
            chainState.sentinelState.liquidationAllowed = liquidationAllowed.ok ? Boolean(liquidationAllowed.value[0]) : null;
            chainState.sentinelState.error = null;

            if (chainState.sentinelState.liquidationAllowed === false) {
              chainState.findings.chain.push(makeFinding({
                chain: chainName,
                chainId,
                reserve: "priceOracleSentinel",
                symbol: null,
                invariant: "oracle-sentinel-liquidation-allowed",
                severity: "watch",
                details: { addressesProvider: providerAddress, sentinel, liquidationAllowed: false },
              }));
            }
          }
        }
      }
    }
  }

  const reservesRaw = await safeCall(rpc, chainState.pool, POOL, "getReservesList", [], chainState.blockTag);
  if (!reservesRaw.ok || !Array.isArray(reservesRaw.value?.[0])) {
    chainState.errors.push(`getReservesList() failed: ${reservesRaw.error || "empty"}`);
    return chainState;
  }

  const reserves = reservesRaw.value[0].map(normalizeAddress).filter(Boolean);
  chainState.reservesRequested = reserves.length;

  for (const reserve of reserves) {
    chainState.reservesScanned += 1;
    const ctx = { rpc, chain: chainName, chainId, pool: chainState.pool, reserve };
    const reserveDataRaw = await safeCall(rpc, chainState.pool, POOL, "getReserveData", [reserve], chainState.blockTag);
    if (!reserveDataRaw.ok) {
      chainState.findings.reserve.push(makeFinding({
        chain: chainName,
        chainId,
        reserve,
        symbol: null,
        invariant: "reserveData-call",
        severity: "violation",
        details: { error: reserveDataRaw.error },
      }));
      continue;
    }

    const parsedData = parseReserveData(reserveDataRaw.raw);
    if (!parsedData) {
      chainState.findings.reserve.push(makeFinding({
        chain: chainName,
        chainId,
        reserve,
        symbol: null,
        invariant: "reserveData-parse",
        severity: "violation",
        details: { reason: "unexpected reserveData tuple width" },
      }));
      continue;
    }

    const config = parseReserveConfig(parsedData.configWord);
    if (config.eModeCategoryId > 0) chainState.eModeCategories.add(config.eModeCategoryId);

    const [reserveTokenMeta, aTokenMeta, stableDebtTokenMeta, variableDebtTokenMeta] = await Promise.all([
      inspectToken(rpc, reserve, chainState.blockTag),
      inspectToken(rpc, parsedData.aTokenAddress, chainState.blockTag),
      inspectToken(rpc, parsedData.stableDebtTokenAddress, chainState.blockTag),
      inspectToken(rpc, parsedData.variableDebtTokenAddress, chainState.blockTag),
    ]);

    const reserveFindings = evaluateReserveInvariants(
      { ...ctx, reserve },
      parsedData,
      config,
      reserveTokenMeta,
      aTokenMeta,
      stableDebtTokenMeta,
      variableDebtTokenMeta,
      chainState.blockTimestamp,
    );

    chainState.findings.reserve.push(...reserveFindings);

    const oracleFindings = await evaluateOracleInvariants(
      ctx,
      reserve,
      reserveTokenMeta?.symbol || null,
      chainState.oracle.priceOracle,
      chainState.blockTimestamp,
      chainState.blockTag,
      chainState,
    );

    chainState.findings.reserve.push(...oracleFindings);
  }

  await scanEmodeCategories(rpc, chainState, chainState.blockTag);
  chainState.userChecks = await scanUserChecks(chainState, chainState.blockTag);
  chainState.findingsCount = {
    info: chainState.findings.chain.length + chainState.findings.reserve.length + chainState.findings.emode.length + chainState.findings.user.length,
  };

  return chainState;
}

function findSeverityCounts(rows) {
  return rows.reduce(
    (acc, row) => {
      const s = row.severity || "info";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    },
    { info: 0, watch: 0, violation: 0, "route-positive": 0 },
  );
}

function mergeFindings(chainStates) {
  const findings = [];
  const chainSummaries = [];
  for (const state of chainStates) {
    const rows = [
      ...state.findings.chain,
      ...state.findings.reserve,
      ...state.findings.emode,
      ...state.findings.user,
    ];
    rows.forEach((row) => {
      findings.push(row);
    });

    chainSummaries.push({
      chainId: state.chainId,
      chain: state.chain,
      pool: state.pool,
      rpcResolved: state.rpcResolved,
      blockNumber: state.blockNumber,
      blockTimestamp: state.blockTimestamp,
      reservesRequested: state.reservesRequested,
      reservesScanned: state.reservesScanned,
      reserveFindings: findSeverityCounts(state.findings.reserve),
      emodeFindings: findSeverityCounts(state.findings.emode),
      chainFindings: findSeverityCounts(state.findings.chain),
      userFindings: findSeverityCounts(state.findings.user),
      eModeCategories: [...state.eModeCategories],
      oracle: {
        addressesProvider: state.oracle.addressesProvider,
        priceOracle: state.oracle.priceOracle,
        sentinel: state.oracle.sentinel,
        sentinelState: state.sentinelState,
      },
      errors: state.errors,
    });
  }
  return { findings, chainSummaries };
}

function makeSummary(chainStates, findings, userChecks) {
  const severity = findSeverityCounts(findings);
  const reserveChecked = chainStates.reduce((acc, r) => acc + (r.reservesScanned || 0), 0);
  const bestHF = userChecks?.healthFactor ?? null;

  let blocker = "No route-positive condition reached (watch-only profile)";
  if (severity["route-positive"] > 0) blocker = "Route-positive path found.";

  return {
    chainsRequested: Object.keys(AAVE_POOLS).length,
    chainsResolved: chainStates.filter((c) => c.rpcResolved).length,
    chainsScanned: chainStates.filter((c) => c.rpcResolved && (c.errors?.length || 0) < 2).length,
    reservesChecked: reserveChecked,
    violations: severity.violation || 0,
    watchRows: severity.watch || 0,
    routePositiveRows: severity["route-positive"] || 0,
    infoRows: severity.info || 0,
    bestHF,
    blocker,
  };
}

function writeSummaryMarkdown(report) {
  const { summary, chainStates = report.chains || [], findings, userChecks } = report;
  const severity = findSeverityCounts(findings);
  const topRows = findings
    .slice()
    .sort((a, b) => (b.severity === "route-positive") - (a.severity === "route-positive"))
    .slice(0, 60);

  const lines = [];
  lines.push("# Aave V3 Formal Invariants");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("Scope: Read-only invariant scan across Aave V3 pools (multichain). ");
  lines.push("");
  lines.push("## Safety");
  lines.push(`- readOnly: ${report.safety.readOnly}`);
  lines.push(`- rpcUrlsStored: ${report.safety.rpcUrlsStored}`);
  lines.push(`- privateKeysRead: ${report.safety.privateKeysRead}`);
  lines.push(`- signedActions: ${report.safety.signedActions}`);
  lines.push(`- routePositive: ${report.safety.routePositive}`);
  lines.push("");
  lines.push("## Global Summary");
  lines.push(`- chainsRequested: ${summary.chainsRequested}`);
  lines.push(`- chainsResolved: ${summary.chainsResolved}`);
  lines.push(`- chainsScanned: ${summary.chainsScanned}`);
  lines.push(`- reservesChecked: ${summary.reservesChecked}`);
  lines.push(`- violations: ${summary.violations}`);
  lines.push(`- watchRows: ${summary.watchRows}`);
  lines.push(`- infoRows: ${summary.infoRows}`);
  lines.push(`- routePositiveRows: ${summary.routePositiveRows}`);
  lines.push(`- bestHF: ${summary.bestHF === null ? "n/a" : Number(summary.bestHF).toFixed(6)}`);
  lines.push(`- blocker: ${summary.blocker}`);
  lines.push("");
  lines.push("## Per-Chain Summary");
  lines.push("| Chain | Reserves Requested | Reserves Scanned | Route-Positive | Watch | Violations | Errors |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const chain of chainStates) {
    let rows;
    if (chain.findings) {
      rows = findSeverityCounts([...chain.findings.chain, ...chain.findings.reserve, ...chain.findings.emode, ...chain.findings.user]);
    } else {
      rows = findSeverityCounts([]);
      for (const bucket of [chain.reserveFindings, chain.emodeFindings, chain.chainFindings, chain.userFindings]) {
        if (!bucket) continue;
        for (const [sev, count] of Object.entries(bucket)) rows[sev] = (rows[sev] || 0) + Number(count || 0);
      }
    }
    const errors = (chain.errors || []).join(", ") || "-";
    lines.push(
      `| ${chain.chain} | ${chain.reservesRequested || 0} | ${chain.reservesScanned || 0} | ${(rows["route-positive"] || 0)} | ${(rows.watch || 0)} | ${(rows.violation || 0)} | ${errors} |`,
    );
  }
  lines.push("");

  lines.push("## User Check");
  if (!userChecks) {
    lines.push("- Not executed (Ethereum RPC unavailable or user account call failed).");
  } else {
    lines.push(`- User: ${userChecks.user}`);
    lines.push(`- Health Factor: ${userChecks.healthFactor === null ? "n/a" : userChecks.healthFactor.toFixed(6)}`);
    lines.push(`- Total Collateral (USD): ${userChecks.totalCollateralUsd === null ? "n/a" : userChecks.totalCollateralUsd.toFixed(2)}`);
    lines.push(`- Total Debt (USD): ${userChecks.totalDebtUsd === null ? "n/a" : userChecks.totalDebtUsd.toFixed(2)}`);
    lines.push(`- Liquidatable: ${userChecks.liquidatable === null ? "n/a" : userChecks.liquidatable}`);
    lines.push(`- Sentinels: borrowAllowed=${userChecks.sentinel?.borrowAllowed}, liquidationAllowed=${userChecks.sentinel?.liquidationAllowed}`);
    lines.push(`- Route-positive: ${userChecks.routePositive}`);
    lines.push(`- Blocker: ${userChecks.routeBlocker || "none"}`);
  }

  lines.push("");
  lines.push("## Bounded Scope Caveats");
  lines.push("- User coverage is not exhaustive: only the configured Ethereum hot borrower is checked as a user-level invariant.");
  lines.push("- Oracle checks are shallow read-only checks (positive accepted price, source/code, Chainlink-style latestRoundData when available); EBBO/full adapter composition is outside this scanner.");
  lines.push("- Cap-boundary rows are watch-only: governance can reduce caps below existing supply/debt, and this is not route-positive without a new borrow/supply bypass.");
  lines.push("- Markdown findings table is truncated to the first 60 rows; JSON contains the complete finding set.");
  lines.push("");
  lines.push("## Findings");
  lines.push("Severity: `route-positive | violation | watch | info`");
  lines.push("");
  lines.push("| Severity | Chain | Reserve | Invariant | Route+ | Details |");
  lines.push("| --- | --- | --- | --- | ---: | --- |");
  for (const row of topRows) {
    const safeDetails = row.details ? JSON.stringify(row.details).replace(/\|/g, "\\|") : "{}";
    lines.push(`| ${row.severity} | ${row.chain} | ${row.reserve || "-"} | ${row.invariant} | ${row.routePositive ? "yes" : "no"} | ${safeDetails} |`);
  }

  lines.push("");
  lines.push(`Total findings: ${findings.length}. Severity split: violation=${severity.violation || 0}, watch=${severity.watch || 0}, info=${severity.info || 0}, route-positive=${severity["route-positive"] || 0}.`);

  fs.writeFileSync(OUT_SUMMARY, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const chainIds = Object.keys(AAVE_POOLS).map((id) => Number(id));
  const rpcPool = await resolveRpcPool(chainIds);

  const chainStates = [];
  const chainOrder = chainIds.sort((a, b) => a - b);

  for (const chainId of chainOrder) {
    const rpc = rpcPool[chainId];
    const chainName = CHAIN_NAMES[chainId] || `chain-${chainId}`;
    console.error(`Scanning ${chainName} (${chainId})...`);
    try {
      const state = await scanChain(chainId, chainName, rpc || null);
      chainStates.push(state);
    } catch (e) {
      const fallback = emptyChainState(chainId, chainName, AAVE_POOLS[chainId], rpc);
      fallback.errors.push(`scan-exception: ${String(e.message || e)}`);
      chainStates.push(fallback);
    }
  }

  const merged = mergeFindings(chainStates);
  const userChecks = chainStates.find((c) => c.chainId === 1)?.userChecks || null;
  const summary = makeSummary(chainStates, merged.findings, userChecks);

  const safety = {
    readOnly: true,
    rpcUrlsStored: false,
    privateKeysRead: false,
    signedActions: false,
    routePositive: summary.routePositiveRows > 0,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/aave-v3-formal-invariants.js",
    scope: "Read-only Aave V3 bounded formal invariant scanner",
    safety,
    summary,
    chains: merged.chainSummaries,
    findings: merged.findings,
    userChecks,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, jsonReplacer, 2)}\n`, "utf8");
  writeSummaryMarkdown(report);

  const routeRowCount = summary.routePositiveRows;
  console.log(`Wrote JSON: ${path.relative(WORKSPACE, OUT_JSON)}`);
  console.log(`Wrote summary: ${path.relative(WORKSPACE, OUT_SUMMARY)}`);
  console.log(`findings: ${merged.findings.length} (route-positive=${routeRowCount}, violations=${summary.violations}, watch=${summary.watchRows})`);
}

main().catch((e) => {
  console.error(`scanner error: ${e?.message || e}`);
  process.exit(1);
});

