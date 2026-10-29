#!/usr/bin/env node
// Read-only Kamino reduced-status live-window ranker.
// Uses the existing no-key decoder; writes sanitized candidate economics only.

const fs = require("fs");
const path = require("path");
const {
  resolveRpcUrls,
  scanOnce,
} = require("../targets/kamino-klend/live-liquidation-executor.js");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-live-window-ranker.json");
const BORROW_DIVERGENCE = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-borrow-divergence.json");
const PROFITABILITY = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-liquidation-profitability.json");
const ORACLE_CONFIG = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-oracle-config.json");

const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const QUOTE_TIMEOUT_MS = Number(process.env.KAMINO_JUP_QUOTE_TIMEOUT_MS || "8000");
const QUOTE_LIMIT = Number(process.env.KAMINO_LIVE_WINDOW_QUOTE_LIMIT || "5");
const SKIP_QUOTES = process.argv.includes("--skip-quotes");

const PRICE_LOADED = 0x01;
const PRICE_AGE_CHECKED = 0x02;
const TWAP_CHECKED = 0x04;
const TWAP_AGE_CHECKED = 0x08;
const HEURISTIC_CHECKED = 0x10;
const PRICE_USAGE_ALLOWED = 0x20;
const ALL_CHECKS = PRICE_LOADED | PRICE_AGE_CHECKED | TWAP_CHECKED | TWAP_AGE_CHECKED | HEURISTIC_CHECKED | PRICE_USAGE_ALLOWED;
const LIQUIDATION_CHECKS = PRICE_LOADED | PRICE_AGE_CHECKED | PRICE_USAGE_ALLOWED;

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function n(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 6) {
  const parsed = n(value, null);
  if (parsed === null) return null;
  const factor = 10 ** decimals;
  return Math.round(parsed * factor) / factor;
}

function hasLiquidationChecks(status) {
  return (n(status) & LIQUIDATION_CHECKS) === LIQUIDATION_CHECKS;
}

function hasAllChecks(status) {
  return (n(status) & ALL_CHECKS) === ALL_CHECKS;
}

function isReducedLiquidationStatus(status) {
  return n(status) !== 0 && hasLiquidationChecks(status) && !hasAllChecks(status);
}

async function scanWithAnyRpc(urls, market) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await scanOnce(url, market);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError?.message || "Kamino scan failed on all configured Solana RPC endpoints");
}

function candidateToJson(row, reserveInfoByKey, quote = null) {
  const collateralReserve = reserveInfoByKey.get(row.collateralReserve || row.selectedDeposit?.reserve) || {};
  const debtReserve = reserveInfoByKey.get(row.debtReserve || row.selectedBorrow?.reserve) || {};
  return {
    obligation: row.pubkey,
    owner: row.owner,
    status: row.status,
    slotAge: row.slotAge,
    lastUpdateSlot: row.lastUpdateSlot,
    debtUsd: round(row.debt, 4),
    unhealthyUsd: round(row.unhealthy, 4),
    debtAboveUnhealthyUsd: round((row.debt || 0) - (row.unhealthy || 0), 4),
    collateral: {
      symbol: collateralReserve.name || row.collateral || null,
      reserve: collateralReserve.pubkey || row.collateralReserve || row.selectedDeposit?.reserve || null,
      liquidityMint: collateralReserve.liquidityMint || null,
      marketValueUsd: round(row.selectedDeposit?.marketValue, 4),
      liquidationThresholdPct: collateralReserve.liquidationThresholdPct ?? null,
    },
    debt: {
      symbol: debtReserve.name || row.debtAsset || null,
      reserve: debtReserve.pubkey || row.debtReserve || row.selectedBorrow?.reserve || null,
      liquidityMint: debtReserve.liquidityMint || null,
      selectedBorrowAmountNative: row.selectedBorrow?.amountNative?.toString?.() || null,
      marketValueUsd: round(row.selectedBorrow?.marketValue, 4),
      borrowFactorPct: debtReserve.borrowFactorPct ?? null,
    },
    economics: {
      repayValueApproxUsd: round(row.repayValue, 4),
      bonusBps: row.bonusBps,
      protocolFeePct: row.protocolFeePct,
      approxBonusValueUsd: round(row.approxBonusValue, 4),
      exactRoutePositive: false,
    },
    quoteGate: quote || {
      checked: false,
      available: false,
      reason: "not-checked",
    },
  };
}

async function quoteDebtToCollateral(row, reserveInfoByKey) {
  if (SKIP_QUOTES) return { checked: false, available: false, reason: "disabled-by-flag" };
  const collateralReserve = reserveInfoByKey.get(row.collateralReserve || row.selectedDeposit?.reserve) || {};
  const debtReserve = reserveInfoByKey.get(row.debtReserve || row.selectedBorrow?.reserve) || {};
  const amount = row.selectedBorrow?.amountNative?.toString?.();
  if (!debtReserve.liquidityMint || !collateralReserve.liquidityMint || !amount || amount === "0") {
    return { checked: false, available: false, reason: "missing-mint-or-amount" };
  }

  const url = new URL("https://quote-api.jup.ag/v6/quote");
  url.searchParams.set("inputMint", debtReserve.liquidityMint);
  url.searchParams.set("outputMint", collateralReserve.liquidityMint);
  url.searchParams.set("amount", amount);
  url.searchParams.set("slippageBps", "50");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return {
      checked: true,
      available: Boolean(json?.outAmount),
      direction: "debt-to-collateral-reference",
      inputMint: debtReserve.liquidityMint,
      outputMint: collateralReserve.liquidityMint,
      inAmount: json?.inAmount || amount,
      outAmount: json?.outAmount || null,
      priceImpactPct: round(json?.priceImpactPct, 6),
      routePlanLength: Array.isArray(json?.routePlan) ? json.routePlan.length : 0,
      exactRoutePositive: false,
      note: "Reference quote only; exact liquidation profitability still needs seized-collateral exit quote and local/fork-equivalent proof.",
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      checked: true,
      available: false,
      error: String(error?.message || error).slice(0, 160),
      exactRoutePositive: false,
    };
  }
}

function buildReserveWatch(scan, artifacts) {
  const borrowRows = artifacts.borrow?.perReserveBorrow || [];
  const profitByReserve = new Map((artifacts.profit?.results || []).map((row) => [row.pubkey, row]));
  const oracleByReserve = new Map((artifacts.oracle?.reserves || []).map((row) => [row.pubkey, row]));
  const rows = [];

  for (const row of borrowRows) {
    const profit = profitByReserve.get(row.pubkey) || {};
    const oracle = oracleByReserve.get(row.pubkey) || {};
    const live = scan.reserveInfoByKey.get(row.pubkey) || {};
    const borrowUsd = n(row.borrowUsd);
    const netPercent = n(profit.netPercent, null);
    const status = live.status ?? oracle.status ?? row.status ?? 0;
    const slotAge = n(row.slotAge, n(live.slot) ? scan.currentSlot - Number(live.slot) : 0);
    const theoreticallyPositive = Boolean(profit.theoreticallyPositive);
    const reducedNow = isReducedLiquidationStatus(status);
    const triggerScore = Math.round(
      (theoreticallyPositive ? 35 : 0)
      + Math.min(25, Math.log10(Math.max(1, borrowUsd)) * 6)
      + Math.min(15, Math.max(0, slotAge) / 600)
      + (oracle?.twap?.max_divergence_bps === 0 ? 10 : 0)
      + (reducedNow ? 20 : 0)
      + Math.min(10, Math.max(0, n(netPercent)) * 250)
    );
    rows.push({
      reserve: row.pubkey,
      symbol: row.symbol || oracle.symbol || live.name || null,
      borrowUsd: round(borrowUsd, 2),
      borrowCount: n(row.borrowCount),
      depositUsd: round(row.depositUsd, 2),
      depositCount: n(row.depositCount),
      status,
      reducedNow,
      liquidationChecksPassed: hasLiquidationChecks(status),
      allChecksPassed: hasAllChecks(status),
      slotAge,
      twapDisabled: oracle?.twap?.max_divergence_bps === 0,
      bonusBps: profit.bonusBps ?? oracle.min_liquidation_bonus_bps ?? null,
      protocolFeePct: profit.protocolFeePct ?? (oracle.protocol_fee_pct != null ? oracle.protocol_fee_pct / 100 : null),
      modeledNetPercent: round(netPercent, 6),
      theoreticallyPositive,
      triggerScore,
    });
  }

  return rows.sort((a, b) => b.triggerScore - a.triggerScore || b.borrowUsd - a.borrowUsd).slice(0, 30);
}

async function main() {
  const marketArg = process.argv.find((arg, idx) => idx > 1 && !arg.startsWith("--")) || process.env.KAMINO_MARKET || MAIN_MARKET;
  const urls = resolveRpcUrls();
  const scan = await scanWithAnyRpc(urls, marketArg);
  const artifacts = {
    borrow: readJson(BORROW_DIVERGENCE),
    profit: readJson(PROFITABILITY),
    oracle: readJson(ORACLE_CONFIG),
  };

  const liveRows = [];
  for (const row of scan.candidates.slice(0, QUOTE_LIMIT)) {
    liveRows.push(candidateToJson(row, scan.reserveInfoByKey, await quoteDebtToCollateral(row, scan.reserveInfoByKey)));
  }
  for (const row of scan.candidates.slice(QUOTE_LIMIT)) {
    liveRows.push(candidateToJson(row, scan.reserveInfoByKey, { checked: false, available: false, reason: "quote-limit" }));
  }

  const historicalRows = (scan.historicalCandidates || [])
    .slice(0, 15)
    .map((row) => candidateToJson(row, scan.reserveInfoByKey, { checked: false, available: false, reason: "historical-not-live" }));
  const reserveWatch = buildReserveWatch(scan, artifacts);
  const quoteAvailable = liveRows.filter((row) => row.quoteGate?.available).length;
  const status = scan.candidates.length > 0
    ? "live-window-needs-exact-quote-and-proof"
    : scan.sameSlotLiquidatableRows > 0
      ? "liquidatable-no-reduced-status-window"
      : scan.sameSlotReducedRows > 0
        ? "reduced-status-no-liquidatable-row"
        : "dormant-no-live-window";

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-kamino-live-window-ranker.js",
    scope: "Read-only Kamino reduced-status live-window ranker with sanitized candidate economics",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      keypairLoaded: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      quoteApiMayBeQueriedForLiveRows: !SKIP_QUOTES,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    market: marketArg,
    status,
    summary: {
      currentSlot: scan.currentSlot,
      reserves: scan.reserves,
      obligations: scan.obligations,
      debtRows: scan.debtRows,
      sameSlotReducedReserves: scan.sameSlotReducedReserves,
      staleReducedDebtRows: scan.staleReducedRows,
      sameSlotReducedDebtRows: scan.sameSlotReducedRows,
      sameSlotLiquidatableRows: scan.sameSlotLiquidatableRows,
      historicalReducedLiquidatableRows: scan.historicalReducedLiquidatableRows,
      liveWindowCandidates: scan.candidates.length,
      liveRowsQuoted: liveRows.filter((row) => row.quoteGate?.checked).length,
      liveRowsQuoteAvailable: quoteAvailable,
      rankedReserveWatchRows: reserveWatch.length,
      topReserveWatch: reserveWatch[0]?.symbol || null,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      borrowDivergence: "reports/raw/fast/kamino-borrow-divergence.json",
      liquidationProfitability: "reports/raw/fast/kamino-liquidation-profitability.json",
      oracleConfig: "reports/raw/fast/kamino-oracle-config.json",
    },
    liveWindowCandidates: liveRows,
    historicalReducedLiquidatableRows: historicalRows,
    reserveWatch,
    blockers: scan.candidates.length > 0
      ? [
        "Live reduced-status liquidation window detected, but routePositive remains 0 until exact collateral-exit economics are positive",
        "Needs local/fork-equivalent Solana execution proof before any signed action",
        "Needs explicit authorization before any live send",
      ]
      : [
        "No current same-slot reduced-status liquidatable Kamino obligation",
        "Theoretical reserve profitability does not matter without a live liquidation window",
        "No exact collateral-exit quote or Solana execution proof exists for a live row",
      ],
    nextSteps: [
      "Refresh this scanner periodically; only liveWindowCandidates > 0 should trigger exact quote/fork-equivalent work",
      "If live rows appear, quote debt acquisition and seized-collateral exit, then prove the liquidation path locally before any signed action",
      "Keep Marginfi recompute and receipt-token consumer graph as next Solana expansions while Kamino remains dormant",
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Kamino live-window ranker: status=${status} live=${scan.candidates.length} sameSlotReduced=${scan.sameSlotReducedRows} sameSlotLiquidatable=${scan.sameSlotLiquidatableRows} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
