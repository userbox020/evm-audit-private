#!/usr/bin/env node
// audit-aave-v3-trigger-readiness.js - read-only Aave V3 trigger/executor readiness audit.
// Resolves RPC in memory only. Does not print/store RPC URLs, read key files, or send transactions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");
const { resolveRpc, sanitizeError } = require("./shared-rpc");
const { buildAaveSourceCoverage, validateAaveSourceCoverageEnvelope } = require("./aave-source-coverage");

const WORKSPACE = path.resolve(__dirname, "..");
const ROUTE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-route-distance.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-trigger-readiness.json");
const MONITOR = path.join(WORKSPACE, "tools", "monitor-aave-v3-executor.js");
const LIQUIDATOR_SOURCE = path.join(WORKSPACE, "contracts", "flash-liquidate-aave-v3", "src", "FlashLiquidateAaveV3.sol");

const CHAIN_ID = 1;
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const AAVE_ORACLE = "0x54586bE62E3c3580375aE3723C145253060Ca0C2";
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WEETH = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee";
const DEFAULT_LIQUIDATOR = "0x1C4Bc8d8b5806C1D73b47bC7ae4c2b6552c858A1";
const QUIET = process.argv.includes("--quiet");
// bounded CLI override: --liquidator <addr> reruns the audit against a different deployed executor
const LIQUI_ARG_INDEX = process.argv.indexOf("--liquidator");
const LIQUIDATOR_OVERRIDE = LIQUI_ARG_INDEX >= 0 && LIQUI_ARG_INDEX + 1 < process.argv.length && /^0x[0-9a-fA-F]{40}$/.test(process.argv[LIQUI_ARG_INDEX + 1]) ? process.argv[LIQUI_ARG_INDEX + 1] : null;
const LIQUIDATOR = LIQUIDATOR_OVERRIDE || DEFAULT_LIQUIDATOR;

const AAVE = new ethers.Interface([
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getAssetPrice(address asset) view returns (uint256)",
]);
const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const FACTORY = new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const V3_POOL = new ethers.Interface(["function liquidity() view returns (uint128)"]);
const LIQ = new ethers.Interface([
  "function execute(uint256 debtToCover,uint256 minProfitWei,uint256 minOut,bytes swapPath) external",
  "function isLiquidatable() view returns (bool,uint256)",
  "function owner() view returns (address)",
]);

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (_) { return ""; }
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

async function resolveEthereumRpc() {
  return resolveRpc(CHAIN_ID, null, { capability: "read", timeoutMs: 6000 });
}

function createReadTracker() {
  return { attempted: 0, succeeded: 0, failed: 0, accountAttempted: 0, accountSucceeded: 0, accountFailed: 0 };
}

function trackRead(tracker, ok, category = "state") {
  if (!tracker) return;
  tracker.attempted += 1;
  tracker[ok ? "succeeded" : "failed"] += 1;
  if (category === "account") {
    tracker.accountAttempted += 1;
    tracker[ok ? "accountSucceeded" : "accountFailed"] += 1;
  }
}

async function safeCall(provider, to, iface, fn, args = [], tracker = null, category = "state") {
  try {
    const target = normalizeAddress(to);
    if (!target) {
      trackRead(tracker, false, category);
      return null;
    }
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(fn, args) });
    const decoded = iface.decodeFunctionResult(fn, raw);
    trackRead(tracker, true, category);
    return decoded;
  } catch (_) {
    trackRead(tracker, false, category);
    return null;
  }
}

function selector(sig) {
  return ethers.id(sig).slice(0, 10).toLowerCase();
}

function extractPush4Selectors(bytecode) {
  const hex = String(bytecode || "").replace(/^0x/i, "");
  const out = new Set();
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2).toLowerCase() === "63") out.add(`0x${hex.slice(i + 2, i + 10).toLowerCase()}`);
  }
  return out;
}

// solc's push optimizer compresses a PUSH4 selector whose most-significant byte is zero
// into PUSH3, dropping that leading zero byte (opcode 0x62, e.g. the Aave V3
// liquidationCall selector 0x00a718a9 is emitted as PUSH3 0xa718a9 = bytes a7 18 a9).
// The stack value is numerically unchanged (0x00a718a9 === 0xa718a9), so the inverse is a
// zero-extension: left-pad the emitted 3 bytes back to 4 bytes. This yields a canonical
// 0x00-prefixed selector and only ever matches selectors that genuinely begin with a 0x00
// byte, which is exactly the set solc compresses this way.
function extractPush3Selectors(bytecode) {
  const hex = String(bytecode || "").replace(/^0x/i, "");
  const out = new Set();
  for (let i = 0; i + 8 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2).toLowerCase() === "62") {
      out.add(`0x${hex.slice(i + 2, i + 8).toLowerCase().padStart(8, "0")}`);
    }
  }
  return out;
}

// Combined view. PUSH4 selectors are the uncompressed form; PUSH3 selectors are the
// leading-zero-compressed form. `push4` is retained separately so genuinely-invalid
// selectors with a non-zero leading byte (e.g. 0x65a6c122) are only ever reported
// through the PUSH4 path, matching how solc would actually emit them.
function extractAaveSelectors(bytecode) {
  const push4 = extractPush4Selectors(bytecode);
  const push3 = extractPush3Selectors(bytecode);
  const selectors = new Set([...push4, ...push3]);
  return { push4, push3, selectors };
}

async function tokenMeta(provider, token, tracker) {
  const [balancerRaw, decimalsRaw, symbolRaw] = await Promise.all([
    safeCall(provider, token, ERC20, "balanceOf", [BALANCER_VAULT], tracker),
    safeCall(provider, token, ERC20, "decimals", [], tracker),
    safeCall(provider, token, ERC20, "symbol", [], tracker),
  ]);
  return {
    symbol: typeof symbolRaw?.[0] === "string" ? symbolRaw[0] : null,
    decimals: decimalsRaw ? Number(decimalsRaw[0]) : null,
    balancerBalanceRaw: balancerRaw?.[0]?.toString?.() || null,
  };
}

function topEthereumRow(route) {
  const rows = Array.isArray(route.globalTopRows) ? route.globalTopRows : [];
  return rows.find((row) => Number(row.chainId) === 1) || rows[0] || null;
}

function sourceAudit(monitorText, liquidatorText) {
  const invalidLiquidateSelector = selector("liquidate(address,address,address,uint256,bool)");
  const correctLiquidationCallSelector = selector("liquidationCall(address,address,address,uint256,bool)");
  return {
    monitor: {
      exists: Boolean(monitorText),
      liveFlagGatePresent: /AAVE_V3_EXECUTE_LIVE|--live/.test(monitorText),
      hardcodedEthereumOnly: /const CHAIN_ID\s*=\s*1/.test(monitorText),
      hardcodedBorrower: /0x1A557354C5b8d7Df38ea914209e416Dc7065b158/i.test(monitorText),
      hardcodedCloseFactorHalf: /const CLOSE_FACTOR\s*=\s*0\.5/.test(monitorText),
      liquidationBonusShiftLooksWrong: /config\s*>>\s*\(32n\s*\*\s*8n\)/.test(monitorText),
      uniswapFeePool: /const FEE_POOL\s*=\s*3000/.test(monitorText) ? 3000 : null,
    },
    liquidatorSource: {
      exists: Boolean(liquidatorText),
      callsAaveLiquidateSelector: /\.liquidate\s*\(/.test(liquidatorText),
      callsAaveLiquidationCallSelector: /\.liquidationCall\s*\(/.test(liquidatorText),
      amountOutMinimumZero: /amountOutMinimum:\s*0/.test(liquidatorText),
      executeOnlyOwner: /function execute[^{]+onlyOwner/.test(liquidatorText),
      invalidLiquidateSelector,
      correctLiquidationCallSelector,
    },
  };
}

async function deployedLiquidatorAudit(provider, address, tracker) {
  const target = normalizeAddress(address);
  if (!target) return { address: null, codePresent: false, error: "invalid-address" };
  let code = "0x";
  try {
    code = await provider.getCode(target);
    trackRead(tracker, code !== "0x");
  } catch (_) {
    trackRead(tracker, false);
  }
  const extracted = extractAaveSelectors(code);
  const selectors = extracted.selectors;
  const invalidLiquidateSelector = selector("liquidate(address,address,address,uint256,bool)");
  const correctLiquidationCallSelector = selector("liquidationCall(address,address,address,uint256,bool)");
  const hasCorrectLiquidationCall = selectors.has(correctLiquidationCallSelector);
  // Record which producer normalized the match: the leading-zero-compressed PUSH3 form
  // (0x00a718a9 emitted as PUSH3 0xa718a9) only when the correct selector was not present
  // as an uncompressed PUSH4 constant.
  const normalizedViaPush3 = hasCorrectLiquidationCall
    && !extracted.push4.has(correctLiquidationCallSelector)
    && extracted.push3.has(correctLiquidationCallSelector);
  const isLiq = await safeCall(provider, target, LIQ, "isLiquidatable", [], tracker);
  const owner = await safeCall(provider, target, LIQ, "owner", [], tracker);
  return {
    address: target,
    codePresent: code !== "0x",
    codeBytes: code !== "0x" ? (code.length - 2) / 2 : 0,
    hasExecuteSelector: selectors.has(selector("execute(uint256,uint256,uint256,bytes)")),
    hasInvalidAaveLiquidateSelector: extracted.push4.has(invalidLiquidateSelector),
    hasCorrectAaveLiquidationCallSelector: hasCorrectLiquidationCall,
    selectorNormalization: normalizedViaPush3 ? "PUSH3_LEADING_ZERO" : null,
    isLiquidatableCallOk: Boolean(isLiq),
    isLiquidatable: Boolean(isLiq?.[0]),
    liveHfFromLiquidator: isLiq ? Number(isLiq[1]) / 1e18 : null,
    owner: normalizeAddress(owner?.[0]),
  };
}

async function liveState(provider, topRow, tracker) {
  const borrower = normalizeAddress(topRow?.user) || "0x1A557354C5b8d7Df38ea914209e416Dc7065b158";
  const account = await safeCall(provider, AAVE_POOL, AAVE, "getUserAccountData", [borrower], tracker, "account");
  const wethMeta = await tokenMeta(provider, WETH, tracker);
  const weethMeta = await tokenMeta(provider, WEETH, tracker);
  const [wethPriceRaw, weethPriceRaw, pool3000Raw, pool500Raw, pool100Raw] = await Promise.all([
    safeCall(provider, AAVE_ORACLE, AAVE, "getAssetPrice", [WETH], tracker),
    safeCall(provider, AAVE_ORACLE, AAVE, "getAssetPrice", [WEETH], tracker),
    safeCall(provider, UNISWAP_V3_FACTORY, FACTORY, "getPool", [WEETH, WETH, 3000], tracker),
    safeCall(provider, UNISWAP_V3_FACTORY, FACTORY, "getPool", [WEETH, WETH, 500], tracker),
    safeCall(provider, UNISWAP_V3_FACTORY, FACTORY, "getPool", [WEETH, WETH, 100], tracker),
  ]);
  const pools = [
    { fee: 3000, pool: normalizeAddress(pool3000Raw?.[0]) },
    { fee: 500, pool: normalizeAddress(pool500Raw?.[0]) },
    { fee: 100, pool: normalizeAddress(pool100Raw?.[0]) },
  ];
  for (const row of pools) {
    const liq = row.pool ? await safeCall(provider, row.pool, V3_POOL, "liquidity", [], tracker) : null;
    if (!row.pool) trackRead(tracker, false);
    row.liquidityRaw = liq?.[0]?.toString?.() || null;
  }
  const topDebtAmount = asNumber(topRow?.topDebt?.amount);
  const estimatedHalfDebtRaw = topDebtAmount ? ethers.parseUnits((topDebtAmount * 0.5).toFixed(12), 18).toString() : null;
  const balancerWeth = BigInt(wethMeta.balancerBalanceRaw || 0);
  return {
    borrower,
    account: account ? {
      totalCollateralUsd: Number(account[0]) / 1e8,
      totalDebtUsd: Number(account[1]) / 1e8,
      availableBorrowsUsd: Number(account[2]) / 1e8,
      liquidationThresholdBps: Number(account[3]),
      ltvBps: Number(account[4]),
      healthFactor: Number(account[5]) / 1e18,
      bpsToLiquidation: (Number(account[5]) / 1e18 - 1) * 10000,
    } : null,
    oraclePrices: {
      wethUsd: wethPriceRaw ? Number(wethPriceRaw[0]) / 1e8 : null,
      weethUsd: weethPriceRaw ? Number(weethPriceRaw[0]) / 1e8 : null,
    },
    flashLiquidity: {
      token: WETH,
      symbol: wethMeta.symbol,
      decimals: wethMeta.decimals,
      balancerBalanceRaw: wethMeta.balancerBalanceRaw,
      estimatedHalfDebtRaw,
      balancerCoversHalfDebt: estimatedHalfDebtRaw ? balancerWeth >= BigInt(estimatedHalfDebtRaw) : false,
    },
    collateralToken: {
      token: WEETH,
      symbol: weethMeta.symbol,
      decimals: weethMeta.decimals,
      balancerBalanceRaw: weethMeta.balancerBalanceRaw,
    },
    uniswapPools: pools,
  };
}

function buildReadinessSourceCoverage(route, tracker) {
  const candidate = route?.sourceCoverage;
  // Structural check (without requiring sample completeness) so a well-formed but
  // incomplete upstream route still contributes its real counters. Otherwise every
  // readiness coverage built on a bounded route carried truncationLimit 0 and failed the
  // shared envelope as "invalid-cap" instead of the truthful "upstream-incomplete".
  const upstreamEnvelope = validateAaveSourceCoverageEnvelope(candidate, {
    protocolVersion: "V3", coverageKind: "route-scan",
  });
  const validation = validateAaveSourceCoverageEnvelope(candidate, {
    protocolVersion: "V3", coverageKind: "route-scan", requireSampleComplete: true,
  });
  const upstream = upstreamEnvelope.valid ? candidate : {};
  const errors = [];
  if (!validation.valid) errors.push(...validation.failures.map(code => `route-source-${code}`));
  if (!tracker || tracker.attempted === 0) errors.push("readiness-state-reads-empty");
  if ((tracker?.failed || 0) > 0 || tracker?.succeeded !== tracker?.attempted) errors.push("readiness-state-read-failed");
  if ((tracker?.accountAttempted || 0) === 0) errors.push("readiness-account-read-skipped");
  if ((tracker?.accountFailed || 0) > 0 || tracker?.accountSucceeded !== tracker?.accountAttempted) errors.push("readiness-account-read-failed");
  const uniqueErrors = [...new Set(errors)];
  const fullHistoryProven = validation.valid && upstream.fullHistoryProven === true;
  const sampleComplete = uniqueErrors.length === 0;
  const exhaustiveProof = fullHistoryProven && upstream.complete === true ? {
    type: "ROUTE_EXHAUSTIVE_PLUS_READINESS_READS",
    exact: true,
    evidence: upstream.exhaustiveProof?.evidence || "upstream-exact-bound",
  } : null;
  return buildAaveSourceCoverage("V3", "readiness", {
    complete: sampleComplete && fullHistoryProven && upstream.complete === true,
    sampleComplete,
    historyScope: upstream.historyScope || "UNDECLARED",
    fullHistoryProven,
    exhaustiveProof,
    observedRanges: Array.isArray(upstream.observedRanges) ? upstream.observedRanges : [],
    blocker: sampleComplete && exhaustiveProof ? null : !fullHistoryProven
      ? "Upstream borrower discovery is a bounded historical sample, not complete active-position coverage."
      : "Readiness state reads or upstream sources are incomplete.",
    routeGeneratedAt: route?.generatedAt || null,
    chainsExpected: upstream.chainsExpected || 0,
    chainsObserved: upstream.chainsObserved || 0,
    requiredChainIds: Array.isArray(upstream.requiredChainIds) ? upstream.requiredChainIds : [],
    observedChainIds: Array.isArray(upstream.observedChainIds) ? upstream.observedChainIds : [],
    logChunksAttempted: upstream.logChunksAttempted || 0,
    logChunksSucceeded: upstream.logChunksSucceeded || 0,
    logChunksFailed: upstream.logChunksFailed || 0,
    discoveredBorrowers: upstream.discoveredBorrowers || 0,
    checkedBorrowers: upstream.checkedBorrowers || 0,
    accountReadsAttempted: upstream.accountReadsAttempted || 0,
    accountReadsSucceeded: upstream.accountReadsSucceeded || 0,
    accountReadsFailed: upstream.accountReadsFailed || 0,
    reserveReadsAttempted: upstream.reserveReadsAttempted || 0,
    reserveReadsSucceeded: upstream.reserveReadsSucceeded || 0,
    reserveReadsFailed: upstream.reserveReadsFailed || 0,
    readinessStateReadsAttempted: tracker?.attempted || 0,
    readinessStateReadsSucceeded: tracker?.succeeded || 0,
    readinessStateReadsFailed: tracker?.failed || 0,
    readinessAccountReadsAttempted: tracker?.accountAttempted || 0,
    readinessAccountReadsSucceeded: tracker?.accountSucceeded || 0,
    readinessAccountReadsFailed: tracker?.accountFailed || 0,
    stateReadsAttempted: (upstream.stateReadsAttempted || 0) + (tracker?.attempted || 0),
    stateReadsSucceeded: (upstream.stateReadsSucceeded || 0) + (tracker?.succeeded || 0),
    stateReadsFailed: (upstream.stateReadsFailed || 0) + (tracker?.failed || 0),
    truncationLimit: upstream.truncationLimit || 0,
    wasTruncated: Boolean(upstream.wasTruncated),
    errors: uniqueErrors,
  });
}

function finding(severity, title, detail) {
  return { severity, title, detail };
}

async function main() {
  const route = readJson(ROUTE, {});
  // An incomplete upstream route must not abort readiness before any read. The readiness
  // source is independent and read-only; its own reads are recorded and the incomplete
  // upstream is surfaced as `route-source-*` errors in the readiness coverage, which keeps
  // the artifact fresh and fail-closed. Aborting here left the readiness artifact permanently
  // stale with no coverage object and no reads.
  const topRow = topEthereumRow(route);
  const monitorText = readText(MONITOR);
  const liquidatorText = readText(LIQUIDATOR_SOURCE);
  const source = sourceAudit(monitorText, liquidatorText);
  const rpc = await resolveEthereumRpc();
  if (!rpc) throw new Error("missing ethereum rpc");
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const readTracker = createReadTracker();
  const [live, deployed] = await Promise.all([
    liveState(provider, topRow, readTracker),
    deployedLiquidatorAudit(provider, LIQUIDATOR, readTracker),
  ]);
  const sourceCoverage = buildReadinessSourceCoverage(route, readTracker);

  const routeSummary = route.summary || {};
  const currentHf = live.account?.healthFactor ?? asNumber(topRow?.healthFactor);
  const triggerReady = Boolean(currentHf !== null && currentHf < 1 && (asNumber(routeSummary.currentLiquidatable) || 0) > 0);
  const exactEconomicsReady = (asNumber(routeSummary.exactEconomicsRows) || 0) > 0 && (asNumber(routeSummary.rowsWithAnyQuote) || 0) > 0;
  const sourceAbiReady = Boolean(source.liquidatorSource.callsAaveLiquidationCallSelector && !source.liquidatorSource.callsAaveLiquidateSelector);
  const monitorMathReady = Boolean(!source.monitor.liquidationBonusShiftLooksWrong);
  const deployedSelectorReady = Boolean(deployed.codePresent && deployed.hasExecuteSelector && deployed.hasCorrectAaveLiquidationCallSelector && !deployed.hasInvalidAaveLiquidateSelector);
  const flashLiquidityReady = Boolean(live.flashLiquidity.balancerCoversHalfDebt);
  const forkProofReady = false;
  const liveExecutorReady = Boolean(triggerReady && exactEconomicsReady && sourceAbiReady && monitorMathReady && deployedSelectorReady && flashLiquidityReady && forkProofReady);

  const findings = [];
  if (!triggerReady) findings.push(finding("high", "HF trigger closed", `current HF=${round(currentHf, 9)}; exact liquidation work waits for HF < 1.0`));
  if (!exactEconomicsReady) findings.push(finding("high", "Exact economics missing", "route-distance artifact has no exact repay acquisition/collateral exit quote rows"));
  if (!sourceAbiReady) findings.push(finding("critical", "Local Aave V3 liquidator source uses wrong Pool selector", "FlashLiquidateAaveV3 calls liquidate(...); Aave V3 Pool exposes liquidationCall(...)"));
  if (!deployedSelectorReady) findings.push(finding("critical", "Configured deployed liquidator selector is not readiness-proven", "deployed bytecode does not prove a correct liquidationCall path (neither the PUSH4 constant nor the leading-zero-compressed PUSH3 form) and/or still contains the invalid liquidate selector"));
  if (!monitorMathReady) findings.push(finding("high", "Monitor liquidation bonus decode is wrong", "monitor-aave-v3-executor.js shifts reserve config by 256 bits instead of 32 bits"));
  if (!forkProofReady) findings.push(finding("high", "Fork proof absent", "no fresh fork/staticCall/estimateGas proof exists for the current borrower/route"));

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/audit-aave-v3-trigger-readiness.js",
    scope: "Read-only Aave V3 trigger and executor readiness audit for the top WETH/weETH watch row",
    classification: sourceCoverage.classification,
    complete: sourceCoverage.complete,
    blocker: sourceCoverage.blocker,
    sourceCoverage,
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      routeDistance: rel(ROUTE),
      monitor: rel(MONITOR),
      liquidatorSource: rel(LIQUIDATOR_SOURCE),
    },
    summary: {
      status: liveExecutorReady ? "ready-needs-explicit-authorization" : "not-trigger-ready-executor-blocked",
      routePositive: 0,
      executableNow: false,
      executableNowCount: 0,
      signedActionJustified: false,
      currentHealthFactor: round(currentHf, 9),
      bpsToLiquidation: round((currentHf - 1) * 10000, 2),
      routeWatchCandidates: asNumber(routeSummary.watchCandidates) || 0,
      currentLiquidatable: asNumber(routeSummary.currentLiquidatable) || 0,
      exactEconomicsRows: asNumber(routeSummary.exactEconomicsRows) || 0,
      rowsWithAnyQuote: asNumber(routeSummary.rowsWithAnyQuote) || 0,
      triggerReady,
      exactEconomicsReady,
      sourceAbiReady,
      monitorMathReady,
      deployedSelectorReady,
      flashLiquidityReady,
      forkProofReady,
      liveExecutorReady,
      findingCount: findings.length,
      blocker: liveExecutorReady
        ? "Ready only after explicit authorization and fresh staticCall/estimateGas gates"
        : "HF is above 1 and executor/readiness gates remain blocked",
    },
    topRow: {
      chain: topRow?.chain || null,
      pool: topRow?.pool || null,
      borrower: topRow?.user || null,
      healthFactor: topRow?.healthFactor ?? null,
      bpsToLiquidation: topRow?.bpsToLiquidation ?? null,
      topDebt: topRow?.topDebt || null,
      topCollateral: topRow?.topCollateral || null,
      economics: topRow?.economics || null,
    },
    live,
    source,
    deployedLiquidator: deployed,
    findings,
    requiredForRoutePositive: [
      "current HF < 1.0 for a material borrower",
      "exact repay-token amount and seized collateral amount are computed from live reserve/debt token balances",
      "exact collateral exit quote into repay token is positive after gas/slippage/flash fees",
      "liquidator source and deployed bytecode use Aave V3 liquidationCall, not a nonexistent liquidate selector",
      "fresh fork/staticCall/estimateGas proof succeeds with minProfit/minOut gates",
      "explicit authorization before any signed action",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  if (!QUIET) {
    console.log(`aaveV3Readiness status=${output.summary.status} hf=${output.summary.currentHealthFactor} exact=${output.summary.exactEconomicsReady} sourceAbi=${output.summary.sourceAbiReady} deployed=${output.summary.deployedSelectorReady}`);
    console.log(`Report: ${rel(OUT)}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`audit-aave-v3-trigger-readiness failed: ${sanitizeError(err, "audit-failed")}`);
    process.exitCode = 1;
  });
}

module.exports = { buildReadinessSourceCoverage, createReadTracker, liveState, safeCall, extractPush4Selectors, extractPush3Selectors, extractAaveSelectors };
