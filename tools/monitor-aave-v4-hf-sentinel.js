#!/usr/bin/env node
// monitor-aave-v4-hf-sentinel.js — Narrow read-only Aave V4 near-liquidation sentinel
// for the closest borrower (HF ~1.002, $3.2M debt). Reads latest artifact files,
// computes trigger thresholds, and writes status to reports/monitor.
// RPC URLs are never printed or persisted.

const fs = require("fs");
const path = require("path");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const WATCH_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const SPOKE_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-spoke-borrowers.json");
const OUT = path.join(WORKSPACE, "reports", "monitor", "aave-v4-hf-sentinel.json");

const QUIET = process.argv.includes("--quiet");
const RUN_ONCE = process.argv.includes("--once");
const WATCH_MODE = process.argv.includes("--watch");
const INTERVAL_MS = Math.max(10_000, Number(argValue("--interval-ms") || "60000") || 60_000);

// --- Hard-coded target identity ---
const TARGET_USER = "0x1A557354C5b8d7Df38ea914209e416Dc7065b158";
const TARGET_SPOKE = "0xbF10BDfE177dE0336aFD7fcCF80A904E15386219";
const TARGET_HUB = "Core Hub";

// --- Confirmed Aave V4 Core Hub protocol parameters ---
const PROTOCOL_CONFIG = {
  closeFactor: 0.5,                // Static 50% — confirmed from V4 spokes
  liquidationFeeBps: 1000,         // 10% protocol fee on liquidation bonus
  collateralFactorBps: 9550,       // weETH collateral factor (95.5%)
  liquidationBonusBps: 10100,      // weETH liquidation bonus (1.01%)
  // Monitoring thresholds
  amberThresholdHf: 1.05,          // HF >= 1.05 = GREEN (healthy)
  redThresholdHf: 1.01,            // 1.0 <= HF < 1.01 = RED (imminent)
  criticalBpsFromLiq: 50,          // HF implying < 50 bps to liquidation = CRITICAL
  // Note: V4 close factor may increase as HF drops further (V3 pattern: 0.5→1.0 linear from HF 1.0→0.95)
  // This sentinel uses conservative 0.5; actual may be higher at lower HF
};

const ORACLE_ADDRESS = "0xd8B153FaAA8f2b1bC774916FEd333A4F3dE48792";

// --- Cost assumptions for net profit ---
const GAS_ESTIMATE_USD = 200;
const FLASH_LOAN_FEE_BPS = 9;     // 0.09% flash loan fee
const SLIPPAGE_BPS = 30;          // 0.3% slippage on weETH→WETH swap

// --- Oracle staleness threshold ---
const ORACLE_STALE_SECONDS = 3600; // 1 hour

// --- Helper functions ---

function argValue(name) {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Core computation ---

function determineStatus(hf, bpsToLiq) {
  if (hf === null || hf === undefined) return { status: "UNKNOWN", liquidatable: false };
  if (hf < 1.0) return { status: "LIQUIDATABLE", liquidatable: true };
  // CRITICAL: HF > 1.0 but bps to liquidation is under the critical threshold
  if (hf > 1.0 && bpsToLiq !== null && bpsToLiq < PROTOCOL_CONFIG.criticalBpsFromLiq) {
    return { status: "CRITICAL", liquidatable: false };
  }
  if (hf < PROTOCOL_CONFIG.redThresholdHf) return { status: "RED", liquidatable: false };
  if (hf < PROTOCOL_CONFIG.amberThresholdHf) return { status: "AMBER", liquidatable: false };
  return { status: "GREEN", liquidatable: false };
}

function buildRecommendation(hf, status) {
  const bps = hf !== null && hf !== undefined ? round((hf - 1) * 10000, 1) : null;
  if (status === "GREEN") return "Health factor healthy; no action needed.";
  if (status === "CRITICAL") {
    return `CRITICAL: ${bps} bps from liquidation — well under ${PROTOCOL_CONFIG.criticalBpsFromLiq} bps threshold. Prepare fork script but do NOT execute. Net profit depends on close-factor curve, DEX liquidity, gas, and flash-loan availability. Conservative estimate assumes 50% close factor.`;
  }
  if (status === "AMBER") {
    return `Monitor closely; ${bps} bps from liquidation (below amber threshold ${PROTOCOL_CONFIG.amberThresholdHf}).`;
  }
  if (status === "RED") {
    return `Monitor closely; ${bps} bps from liquidation (below red threshold ${PROTOCOL_CONFIG.redThresholdHf}). Do NOT fork or execute — HF > 1.0.`;
  }
  if (status === "LIQUIDATABLE") return "Borrower is liquidatable! Ready to fork and execute.";
  return "Status unknown; review data.";
}

/**
 * Scan through the spoke artifact topUsers for our target user.
 * Returns the matching user object or null.
 */
function findTargetUser(spokeArtifact) {
  if (!spokeArtifact || !Array.isArray(spokeArtifact.spokes)) return null;
  for (const spoke of spokeArtifact.spokes) {
    if (spoke.spoke !== TARGET_SPOKE) continue;
    if (!Array.isArray(spoke.topUsers)) continue;
    for (const entry of spoke.topUsers) {
      if (entry.user === TARGET_USER) return entry;
    }
  }
  return null;
}

/**
 * Extract the top debt and top collateral from the watch artifact's top row
 * for the target user. Falls back to scanning spoke artifact.
 */
function extractOracleData(spokeArtifact) {
  // Attempt to extract oracle updatedAt from the spoke artifact for target user's reserves
  const userEntry = findTargetUser(spokeArtifact);
  if (!userEntry) return { debtOracle: null, collOracle: null };

  const reserves = userEntry.reserves || [];
  const debtReserve = reserves.find((r) => (asNumber(r.debtUsd) || 0) > 0);
  const collReserve = reserves.find(
    (r) => r.usingAsCollateral !== false && (asNumber(r.suppliedUsd) || 0) > 0
  );

  return {
    debtOracle: debtReserve?.oracleData || null,
    collOracle: collReserve?.oracleData || null,
  };
}

function extractBorrowerData(watchArtifact, spokeArtifact) {
  // Try watch artifact first — it has the concise summary
  const topRow = (watchArtifact?.latest?.topRows || []).find(
    (r) => r.user === TARGET_USER && r.spoke === TARGET_SPOKE
  );
  if (topRow) {
    return {
      healthFactor: asNumber(topRow.healthFactor),
      bpsToLiquidation: asNumber(topRow.bpsToLiquidation),
      collateralDropToLiquidationPct: asNumber(topRow.collateralDropToLiquidationPct),
      debtUsd: asNumber(topRow.debtUsd),
      collateralUsd: asNumber(topRow.collateralUsd),
      potentialGrossBonusUsd: asNumber(topRow.potentialGrossBonusUsd),
      topDebtSymbol: topRow.topDebt?.symbol || null,
      topCollateralSymbol: topRow.topCollateral?.symbol || null,
      liquidationBonusBps: topRow.topCollateral?.liquidationBonusBps || PROTOCOL_CONFIG.liquidationBonusBps,
    };
  }

  // Fallback: compute from spoke artifact raw data
  const userEntry = findTargetUser(spokeArtifact);
  if (!userEntry) return null;

  const reserves = userEntry.reserves || [];
  const debts = reserves
    .filter((r) => (asNumber(r.debtUsd) || 0) > 0)
    .sort((a, b) => (asNumber(b.debtUsd) || 0) - (asNumber(a.debtUsd) || 0));
  const collaterals = reserves
    .filter((r) => r.usingAsCollateral !== false && (asNumber(r.suppliedUsd) || 0) > 0)
    .sort((a, b) => (asNumber(b.suppliedUsd) || 0) - (asNumber(a.suppliedUsd) || 0));

  const healthFactor = asNumber(userEntry.account?.healthFactor);
  const debtUsd = debts.reduce((s, r) => s + (asNumber(r.debtUsd) || 0), 0);
  const collateralUsd = collaterals.reduce((s, r) => s + (asNumber(r.suppliedUsd) || 0), 0);
  const topDebt = debts[0] || null;
  const topCollateral = collaterals[0] || null;
  const topCollateralBonusBps = topCollateral?.dynamicConfig?.maxLiquidationBonusBps || PROTOCOL_CONFIG.liquidationBonusBps;
  const bonusBps = Math.max(0, topCollateralBonusBps - 10000);
  const bpsToLiquidation = Number.isFinite(healthFactor) ? Math.max(0, (healthFactor - 1) * 10000) : null;
  const collateralDropPct = Number.isFinite(healthFactor) && healthFactor > 1
    ? (1 - (1 / healthFactor)) * 100
    : 0;
  const potentialGrossBonusUsd = Math.min(debtUsd, collateralUsd) * bonusBps / 10000;

  return {
    healthFactor,
    bpsToLiquidation: round(bpsToLiquidation, 2),
    collateralDropToLiquidationPct: round(collateralDropPct, 4),
    debtUsd: round(debtUsd, 2),
    collateralUsd: round(collateralUsd, 2),
    potentialGrossBonusUsd: round(potentialGrossBonusUsd, 2),
    topDebtSymbol: topDebt?.symbol || null,
    topCollateralSymbol: topCollateral?.symbol || null,
    liquidationBonusBps: topCollateralBonusBps,
  };
}

function computeNetProfit(debtUsd, bonusBps) {
  // Final estimated net:
  //   (debt × closeFactor × (bonusBps - 10000)/10000)
  //   × (1 - protocolFee/10000)
  //   - gas - flashFee - slippage
  const bonusFraction = Math.max(0, bonusBps - 10000) / 10000;
  const grossAfterClose = debtUsd * PROTOCOL_CONFIG.closeFactor * bonusFraction;
  const grossAfterProtocol = grossAfterClose * (1 - PROTOCOL_CONFIG.liquidationFeeBps / 10000);
  const flashFee = debtUsd * (FLASH_LOAN_FEE_BPS / 10000);
  const slippage = debtUsd * PROTOCOL_CONFIG.closeFactor * (SLIPPAGE_BPS / 10000);
  const net = grossAfterProtocol - GAS_ESTIMATE_USD - flashFee - slippage;
  return round(net, 2);
}

function computeReport(data, chainTimestamp) {
  const hf = asNumber(data?.healthFactor);
  const bpsToLiq = data?.bpsToLiquidation !== null ? asNumber(data?.bpsToLiquidation) : null;
  const debtUsd = asNumber(data?.debtUsd) || 0;
  const grossBonus = asNumber(data?.potentialGrossBonusUsd) || 0;
  const bonusBps = data?.liquidationBonusBps || PROTOCOL_CONFIG.liquidationBonusBps;

  // Gross profit: debt × (bonusBps - 10000)/10000, then apply close factor
  const estimatedGrossProfitUsd = round(grossBonus * PROTOCOL_CONFIG.closeFactor, 2);
  // Net profit after all costs
  const estimatedNetProfitUsd = computeNetProfit(debtUsd, bonusBps);

  // Oracle freshness — use chain block timestamp as a proxy (no updatedAt in V4 artifact)
  let oracleAgeSeconds = null;
  let oracleStale = null;
  if (chainTimestamp) {
    const now = Math.floor(Date.now() / 1000);
    oracleAgeSeconds = now - chainTimestamp;
    oracleStale = oracleAgeSeconds > ORACLE_STALE_SECONDS;
  }

  const { status, liquidatable } = determineStatus(hf, bpsToLiq);
  const recommendation = buildRecommendation(hf, status);

  const riskNote = "Net profit depends on close-factor curve, DEX liquidity, gas, and flash-loan availability. Conservative estimate assumes 50% close factor.";

  return {
    generatedAt: new Date().toISOString(),
    scanner: "tools/monitor-aave-v4-hf-sentinel.js",
    scope: "Read-only Aave V4 single-borrower HF sentinel",
    safety: {
      signedActions: false,
      routePositive: false,
      executableNow: false,
    },
    borrower: {
      user: TARGET_USER,
      hub: TARGET_HUB,
      spoke: TARGET_SPOKE,
      healthFactor: hf !== null ? round(hf, 9) : null,
      bpsToLiquidation: bpsToLiq,
      collateralDropToLiquidationPct: data?.collateralDropToLiquidationPct !== null
        ? asNumber(data?.collateralDropToLiquidationPct)
        : null,
      debtUsd: round(debtUsd, 2),
      collateralUsd: data?.collateralUsd !== null ? round(asNumber(data?.collateralUsd), 2) : null,
      topDebtSymbol: data?.topDebtSymbol || null,
      topCollateralSymbol: data?.topCollateralSymbol || null,
      estimatedGrossProfitUsd,
      estimatedNetProfitUsd,
      status,
      liquidatable,
      riskNote,
      recommendation,
    },
    oracle: {
      address: ORACLE_ADDRESS,
      ageSeconds: oracleAgeSeconds,
      stale: oracleStale,
      note: chainTimestamp
        ? `Oracle updatedAt not stored in Aave V4 spoke scanner artifact. Chain block timestamp ${chainTimestamp} used as proxy.`
        : "Oracle updatedAt not available — chain timestamp not found in artifacts.",
    },
    oracleNote: `Both WETH and weETH use same oracle (${ORACLE_ADDRESS}) with different price sources (0x5424384B2... for WETH, 0x8762539353... for weETH). Isolated manipulation is harder.`,
    config: PROTOCOL_CONFIG,
  };
}

// --- Main ---

async function runIteration() {
  const watchArtifact = loadJson(WATCH_ARTIFACT, null);
  const spokeArtifact = loadJson(SPOKE_ARTIFACT, null);

  if (!watchArtifact && !spokeArtifact) {
    throw new Error("Neither watch artifact nor spoke artifact found. Run scan-aave-v4-spoke-borrowers.js first.");
  }

  const data = extractBorrowerData(watchArtifact, spokeArtifact);
  if (!data) {
    throw new Error(`Target user ${TARGET_USER} not found in artifacts.`);
  }

  // Attach chain timestamp from artifact for oracle freshness proxy
  const chainTimestamp =
    watchArtifact?.latest?.chain?.timestamp ||
    spokeArtifact?.chain?.timestamp ||
    null;

  const report = computeReport(data, chainTimestamp);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

  if (!QUIET) {
    const hf = report.borrower.healthFactor;
    const status = report.borrower.status;
    const bps = report.borrower.bpsToLiquidation;
    const debt = report.borrower.debtUsd;
    const netProfit = report.borrower.estimatedNetProfitUsd;
    console.log(`Aave V4 HF sentinel: HF=${hf} bpsToLiq=${bps} debtUsd=${debt} netProfitUsd=${netProfit} status=${status}`);
    console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
  }

  return report;
}

async function main() {
  const isWatchMode = WATCH_MODE && !RUN_ONCE;
  const iterations = RUN_ONCE ? 1 : (isWatchMode ? Infinity : 1);

  let iteration = 0;
  while (iteration < iterations) {
    try {
      await runIteration();
    } catch (err) {
      console.error(`monitor-aave-v4-hf-sentinel iteration ${iteration + 1} failed: ${err.message}`);
      if (!isWatchMode) {
        process.exitCode = 1;
        break;
      }
    }
    iteration++;
    if (isWatchMode && iteration < iterations) {
      await sleep(INTERVAL_MS);
    }
  }
}

main().catch((err) => {
  console.error(`monitor-aave-v4-hf-sentinel failed: ${err.message}`);
  process.exitCode = 1;
});
