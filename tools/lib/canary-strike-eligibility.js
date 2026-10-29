"use strict";

// Read-only triage. This is NOT signing authority and cannot dispatch a trade.
const PAXG_MARKET = "0x8eaf7b29f02ba8d8c1d7aeb587403dcb16e2e943e4e2f5f94b0963c2386406c9";
const BWUSDC_MARKET = "0x3c41bb7bcd549d7526f0b223f1f5821cb4db5583667f8fed5a59d5556a1e4a1c";
const MARKET_RE = /^0x[0-9a-f]{64}$/iu;
const MAX_SIGNAL_AGE_MS = 10 * 60 * 1000;

function classifyStrike(spec) {
  if (!spec || !MARKET_RE.test(spec.marketId || "") || !Number.isInteger(Number(spec.chainId))) {
    return "INVALID_SPEC";
  }
  const id = spec.marketId.toLowerCase();
  if (id === BWUSDC_MARKET) return "BLOCKED_REAL_DEPOSIT";
  if (spec.routeStatus !== "fork-verified" || spec.routePositive !== true) {
    return "MONITOR_ONLY_UNPROVEN_OR_UNPRICED";
  }
  if (Number(spec.chainId) === 1 && id === PAXG_MARKET) return "PAXG_REQUIRES_LIVE_ROUTE_PREFLIGHT";
  return "REQUIRES_REAL_FUNDING_AND_EXIT_PROOF";
}

function assessPaxg(signal, canonicalState, nowMs = Date.now()) {
  const blockers = [];
  if (!signal || signal.schema !== "exploit-rearm-canary/v1" || signal.chainId !== 1 ||
      signal.noSigning !== true || signal.noBroadcast !== true ||
      !signal.pin || !Number.isInteger(signal.pin.block) ||
      !Number.isFinite(Date.parse(signal.generatedAt)) ||
      !Number.isFinite(nowMs) ||
      nowMs < Date.parse(signal.generatedAt) ||
      nowMs - Date.parse(signal.generatedAt) > MAX_SIGNAL_AGE_MS) {
    blockers.push("SIGNAL_INVALID_OR_STALE");
  }
  const rows = Array.isArray(signal?.sentinels) ? signal.sentinels : [];
  const row = rows.find((s) => s?.sentinel === "morpho-paxg-misscale");
  if (!row || row.ok !== true || row.fired !== true || row.chainId !== 1 ||
      !/^(0|[1-9][0-9]*)$/u.test(row.measurements?.availableLiquidityUsdcWei || "") ||
      BigInt(row.measurements.availableLiquidityUsdcWei) < 101_000_000n) {
    blockers.push("PAXG_NO_BORROWABLE_WINDOW");
  }
  // Only the canonical signature-verified module may supply this state. A
  // monitoring batch JSON, even if it claims approval, never passes this gate.
  if (!canonicalState || canonicalState.state !== "VALID" ||
      canonicalState.batch?.schema !== "live-execution-batch/v3" ||
      canonicalState.batch.mode !== "PRODUCTION" ||
      canonicalState.batch.chainId !== "1" ||
      !canonicalState.approval?.scopeCommitment ||
      !canonicalState.batchCommitment) {
    blockers.push("SIGNED_V3_AUTHORITY_REQUIRED");
  }
  // Real-asset funding, per-action simulation, conservative economics, and
  // receipt/nonce safety need an independent proof and dispatcher preflight.
  // This observational triage deliberately NEVER emits an executable state.
  blockers.push("ROUTE_REAL_FORK_AND_CONSERVATIVE_NET_REQUIRED");
  return { route: "paxg-ethereum", monitoringOnly: true, blockers };
}

module.exports = { PAXG_MARKET, BWUSDC_MARKET, MAX_SIGNAL_AGE_MS, classifyStrike, assessPaxg };
