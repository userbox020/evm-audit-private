#!/usr/bin/env node
// Read-only Solana profit-hypothesis ranker.
// Consumes existing sanitized artifacts only; no RPC calls and no signed actions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "solana-profit-hypotheses.json");

const FILES = {
  solanaStatus: path.join(WORKSPACE, "reports", "monitor", "solana-status.json"),
  kaminoBorrowDivergence: path.join(WORKSPACE, "reports", "raw", "fast", "kamino-borrow-divergence.json"),
  kaminoProfitability: path.join(WORKSPACE, "reports", "raw", "fast", "kamino-liquidation-profitability.json"),
  kaminoLiveWindowRanker: path.join(WORKSPACE, "reports", "raw", "fast", "kamino-live-window-ranker.json"),
  kaminoDexOracleCrossref: path.join(WORKSPACE, "reports", "raw", "fast", "kamino-dex-oracle-crossref.json"),
  kaminoMultiplyPositions: path.join(WORKSPACE, "reports", "raw", "fast", "kamino-multiply-positions.json"),
  marginfiOracleConfig: path.join(WORKSPACE, "reports", "raw", "fast", "marginfi-oracle-config.json"),
  marginfiHealthRecompute: path.join(WORKSPACE, "reports", "raw", "fast", "marginfi-health-recompute.json"),
  jupiterLendOracleDivergence: path.join(WORKSPACE, "reports", "raw", "fast", "jupiter-lend-oracle-divergence.json"),
  solanaReceiptTokenConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "solana-receipt-token-consumer-graph.json"),
  solanaConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "solana-consumer-routes.json"),
  driftSolanaConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "drift-solana-consumer-routes.json"),
  steammMarketability: path.join(WORKSPACE, "reports", "raw", "steamm-candidate-marketability.json"),
  suilendCandidateProbe: path.join(WORKSPACE, "reports", "raw", "suilend-suite-candidate-probe.json"),
};

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 4) {
  const parsed = n(value, null);
  if (parsed === null) return null;
  const factor = 10 ** decimals;
  return Math.round(parsed * factor) / factor;
}

function rankCandidate(row) {
  return {
    ...row,
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    forkGate: "closed-route-positive-zero",
  };
}

function main() {
  const artifacts = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readJson(file)]));
  const kaminoStatus = artifacts.solanaStatus?.kamino || {};
  const marginfiStatus = artifacts.solanaStatus?.marginfi || {};
  const kaminoBorrow = artifacts.kaminoBorrowDivergence?.summary || {};
  const kaminoProfit = artifacts.kaminoProfitability?.summary || {};
  const kaminoLive = artifacts.kaminoLiveWindowRanker?.summary || {};
  const marginfiConfig = artifacts.marginfiOracleConfig?.summary || {};
  const marginfiRecompute = artifacts.marginfiHealthRecompute?.summary || {};
  const jup = artifacts.jupiterLendOracleDivergence?.summary || {};
  const receiptGraph = artifacts.solanaReceiptTokenConsumerGraph?.summary || {};
  const solConsumer = artifacts.solanaConsumerRoutes?.summary || {};
  const drift = artifacts.driftSolanaConsumerRoutes?.summary || {};
  const steamm = artifacts.steammMarketability?.summary || {};
  const suilend = artifacts.suilendCandidateProbe?.steamm || {};

  const candidates = [
    rankCandidate({
      id: "kamino-reduced-status-live-window",
      protocol: "Kamino Klend",
      chain: "Solana",
      surface: "Reduced oracle-status liquidation window",
      status: n(kaminoLive.liveWindowCandidates || kaminoStatus.liquidatable) > 0 ? "live-window-needs-exact-economics" : "dormant-live-window-instrumented",
      priorityScore: n(kaminoLive.liveWindowCandidates || kaminoStatus.liquidatable) > 0 ? 96 : 58,
      evidence: {
        reserves: kaminoStatus.reserves || kaminoBorrow.reserves || null,
        obligations: kaminoStatus.obligations || kaminoBorrow.obligations || null,
        debtRows: kaminoStatus.debtRows || kaminoBorrow.debtObligations || null,
        liveWindowCandidates: kaminoLive.liveWindowCandidates || 0,
        sameSlotReducedRows: kaminoLive.sameSlotReducedDebtRows || kaminoStatus.sameSlotReducedRows || kaminoBorrow.sameSlotReduced || 0,
        sameSlotLiquidatableRows: kaminoLive.sameSlotLiquidatableRows || kaminoStatus.sameSlotLiquidatableRows || kaminoBorrow.sameSlotLiquidatable || 0,
        liveLiquidatable: kaminoStatus.liquidatable || 0,
        historicalReducedLiquidatableRows: kaminoLive.historicalReducedLiquidatableRows || kaminoStatus.historicalReducedLiquidatableRows || 0,
        staleReducedRows: kaminoLive.staleReducedDebtRows || kaminoStatus.staleReducedRows || 0,
        theoreticallyPositiveReserves: kaminoProfit.theoreticallyPositive || 0,
        bestNetPctModel: round(kaminoProfit.bestNetPct, 4),
      },
      blockers: [
        "No current same-slot liquidatable/reduced-status window",
        "Theoretical profitability uses conservative model, not exact Jupiter routes",
        "Solana CPI execution proof requires a local or fork-equivalent harness before live action",
      ],
      nextStep: "Keep the Kamino live-window ranker on periodic refresh; only exact-quote and prove if liveWindowCandidates becomes positive.",
    }),
    rankCandidate({
      id: "marginfi-full-health-recompute",
      protocol: "Marginfi",
      chain: "Solana",
      surface: "HealthCache observed-unhealthy to full bank/oracle recompute",
      status: n(marginfiRecompute.freshObservedUnhealthy) > 0 || n(marginfiRecompute.freshCleanCachedConservativeLiquidatable) > 0
        ? "fresh-recompute-watch-needs-live-oracle-proof"
        : "recomputed-no-fresh-window",
      priorityScore: n(marginfiRecompute.freshObservedUnhealthy) > 0 || n(marginfiRecompute.freshCleanCachedConservativeLiquidatable) > 0 ? 88 : 56,
      evidence: {
        banksObserved: marginfiStatus.banks || null,
        accountsObserved: marginfiStatus.accounts || null,
        healthCacheDecoded: marginfiStatus.decoded || null,
        observedUnhealthy: marginfiStatus.observedUnhealthy || 0,
        staleUnhealthy: marginfiStatus.staleUnhealthy || 0,
        recomputedLiquidatable: marginfiStatus.recomputedLiquidatable || 0,
        banksDecoded: marginfiConfig.banksDecoded || 0,
        operationalBanks: marginfiConfig.operationalBanks || 0,
        highLtvBanks: marginfiConfig.highLTVBanks || 0,
        watchCandidates: marginfiConfig.watchCandidates || 0,
        recomputeBanksDecoded: marginfiRecompute.banksDecoded || 0,
        debtHealthRows: marginfiRecompute.debtHealthRows || 0,
        freshObservedUnhealthy: marginfiRecompute.freshObservedUnhealthy || 0,
        staleObservedUnhealthy: marginfiRecompute.staleObservedUnhealthy || 0,
        conservativeLiquidatable: marginfiRecompute.conservativeLiquidatable || 0,
        materialConservativeLiquidatable: marginfiRecompute.materialConservativeLiquidatable || 0,
        recomputedRowsWithStaleOrZeroBankPrice: marginfiRecompute.recomputedRowsWithStaleOrZeroBankPrice || 0,
        cleanCachedConservativeLiquidatable: marginfiRecompute.cleanCachedConservativeLiquidatable || 0,
        materialCleanCachedConservativeLiquidatable: marginfiRecompute.materialCleanCachedConservativeLiquidatable || 0,
        freshCleanCachedConservativeLiquidatable: marginfiRecompute.freshCleanCachedConservativeLiquidatable || 0,
        oracleTypes: marginfiConfig.oracleTypes || {},
      },
      blockers: [
        "No fresh observed-unhealthy Marginfi account",
        "Cached-bank recompute rows are dominated by stale oracle cache and are not executable",
        "Current fresh observed-unhealthy count is zero",
      ],
      nextStep: "Keep Marginfi recompute on watch; parse live oracle accounts only if fresh observed-unhealthy or fresh clean cached-liquidatable rows appear.",
    }),
    rankCandidate({
      id: "solana-receipt-token-consumer-graph",
      protocol: "Kamino / Marginfi / Jupiter Lend / Drift",
      chain: "Solana",
      surface: "Receipt-token, LST, PT, Token-2022 consumer graph",
      status: n(receiptGraph.watchCandidates) > 0 ? "instrumented-watch-candidates-no-route-positive" : "instrumented-no-material-route",
      priorityScore: n(receiptGraph.watchCandidates) > 0 ? 68 : 42,
      evidence: {
        xstocksMintsScanned: solConsumer.mintsScanned || 0,
        xstocksProtocolMatches: solConsumer.protocolMatches || 0,
        driftMatches: drift.matches || 0,
        jupiterVaults: jup.vaultsScanned || 0,
        jupiterMintsDiscovered: jup.mintsDiscovered || 0,
        graphConsumerRows: receiptGraph.consumerRows || 0,
        graphUniqueConsumerMints: receiptGraph.uniqueConsumerMints || 0,
        graphToken2022ConsumerMints: receiptGraph.token2022ConsumerMints || 0,
        graphReceiptLikeConsumerMints: receiptGraph.receiptLikeConsumerMints || 0,
        graphWatchCandidates: receiptGraph.watchCandidates || 0,
        graphRoutePositive: receiptGraph.routePositive || 0,
      },
      blockers: [
        "Watch rows are consumer-linked risk surfaces, not proven exploitable routes",
        "Token-2022 authority/extension presence alone is not a producer-side exploit",
        "No exact borrow/liquidation/exit economics or local/fork-equivalent proof",
      ],
      nextStep: "For the top graph watch row only, verify whether the producer trait changes protocol accounting/transfer semantics, then exact-quote before proof work.",
    }),
    rankCandidate({
      id: "jupiter-lend-operate-liquidate-divergence",
      protocol: "Jupiter Lend",
      chain: "Solana",
      surface: "Operate-vs-liquidate oracle divergence with debt-bearing ticks",
      status: n(jup.oracleOperateLiquidateDivergent) > 0 ? "divergence-watch" : "clean-current-sample",
      priorityScore: 46,
      evidence: {
        vaultsScanned: jup.vaultsScanned || 0,
        positionsScanned: jup.positionsScanned || 0,
        ticksScanned: jup.ticksScanned || 0,
        oraclesScanned: jup.oraclesScanned || 0,
        oracleOperateLiquidateDivergent: jup.oracleOperateLiquidateDivergent || 0,
        maxAbsLiquidateVsOperateBps: jup.maxAbsLiquidateVsOperateBps || 0,
        candidateRows: jup.candidateRows || 0,
      },
      blockers: [
        "No operate-vs-liquidate oracle divergence in refreshed sample",
        "No debt-bearing divergent oracle candidate",
      ],
      nextStep: "Keep as a periodic refresh only; reopen if divergent debt-bearing oracle rows appear.",
    }),
    rankCandidate({
      id: "kamino-dex-oracle-manipulation-port",
      protocol: "Kamino Klend / Scope",
      chain: "Solana",
      surface: "DEX oracle manipulation route port",
      status: "closed-current-deployment",
      priorityScore: 35,
      evidence: {
        dexOracleReserves: artifacts.kaminoDexOracleCrossref?.dexOracleReserves || 0,
        totalReserves: artifacts.kaminoDexOracleCrossref?.totalReserves || 0,
        multiplyNearLiquidation: artifacts.kaminoMultiplyPositions?.total || 0,
      },
      blockers: [
        "Kamino reserves with DEX oracle types = 0",
        "No near-liquidation Multiply obligations",
      ],
      nextStep: "Do not spend time here unless Scope/Kamino config changes or new reserves consume DEX oracle types.",
    }),
    rankCandidate({
      id: "suilend-steamm-confirmed-but-unmarketable",
      protocol: "Suilend / STEAMM",
      chain: "Sui",
      surface: "STEAMM zero-offset one-sided CPMM drain marketability",
      status: "confirmed-shape-marketability-blocked",
      priorityScore: 31,
      evidence: {
        zeroOffsetOneSidedCpmmPoolCount: suilend.zeroOffsetOneSidedCpmmPoolCount || 0,
        candidateCount: steamm.candidateCount || 0,
        dexPricedCount: steamm.dexPricedCount || 0,
        bestLiquidityUsd: steamm.bestLiquidityUsd || 0,
      },
      blockers: [
        "Non-Solana branch; user pivot is Solana-first",
        "No DexScreener-priced output token in latest artifact",
        "Bounty scope ambiguity and no valuable marketability",
      ],
      nextStep: "Leave parked unless new STEAMM pools have priced/valuable outputs or scope clarification arrives.",
    }),
  ].sort((a, b) => (b.routePositive - a.routePositive) || (b.priorityScore - a.priorityScore));

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/rank-solana-profit-hypotheses.js",
    scope: "Read-only ranked Solana profit-hypothesis queue from refreshed artifacts",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    summary: {
      hypothesesRanked: candidates.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      topHypothesis: candidates[0]?.id || null,
      recommendedNextStep: candidates[0]?.nextStep || null,
    },
    sourceArtifacts: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, path.relative(WORKSPACE, file)])),
    ranked: candidates.map((row, idx) => ({ rank: idx + 1, ...row })),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`Solana hypotheses: ranked=${out.summary.hypothesesRanked} routePositive=0 top=${out.summary.topHypothesis}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main();
