#!/usr/bin/env node
// Read-only bridge non-lossless token accounting inventory.
// Aggregates existing sanitized artifacts and reports. Does not read RPC secrets,
// does not send transactions, and does not create any execution path.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "bridge-nonlossless-routes.json");

const FILES = {
  wormholeLive: path.join(WORKSPACE, "reports", "raw", "fast", "wormhole-live.json"),
  wormholeToken2022: path.join(WORKSPACE, "reports", "raw", "fast", "wormhole-token2022-fee-wrappers.json"),
  wormholeReport: path.join(WORKSPACE, "reports", "wormhole-portal-ntt-triage.md"),
  axelarLive: path.join(WORKSPACE, "reports", "raw", "fast", "axelar-live.json"),
  axelarReport: path.join(WORKSPACE, "reports", "axelar-gmp-its-triage.md"),
  layerzeroLive: path.join(WORKSPACE, "reports", "raw", "fast", "layerzero-v2-live.json"),
  layerzeroReport: path.join(WORKSPACE, "reports", "layerzero-v2-triage.md"),
  debridgeLive: path.join(WORKSPACE, "reports", "raw", "fast", "debridge-live.json"),
  debridgeBalances: path.join(WORKSPACE, "reports", "raw", "fast", "debridge-callproxy-balances.json"),
  debridgeReport: path.join(WORKSPACE, "reports", "debridge-dln-triage.md"),
  hyperlaneWarpRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlane-warp-routes.json"),
  hyperlaneReport: path.join(WORKSPACE, "reports", "hyperlane-manual-review.md"),
  hyperlaneBaseSummary: path.join(WORKSPACE, "reports", "hyperlane-base-deployed", "onchain-summary.md"),
};

const MATERIAL_USD = Number(process.env.BRIDGE_NONLOSSLESS_MATERIAL_USD || "10000");
const MATERIAL_TOKEN_FLOOR = Number(process.env.BRIDGE_NONLOSSLESS_MATERIAL_TOKEN_FLOOR || "100");

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function readText(file) {
  try {
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return "";
  }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function numberFromText(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[$,%`,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractBacktickNumber(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + "\\s*\\|\\s*`([^`]+)`", "i");
  const match = text.match(re);
  return match ? numberFromText(match[1]) : null;
}

function humanAmount(raw, decimals) {
  try {
    const value = BigInt(raw || 0);
    const d = Number(decimals || 0);
    if (value === 0n) return 0;
    const scale = 10n ** BigInt(Math.max(0, d));
    const whole = value / scale;
    const frac = value % scale;
    const fracText = frac.toString().padStart(d, "0").slice(0, 6).replace(/0+$/, "");
    return Number(`${whole.toString()}${fracText ? "." + fracText : ""}`);
  } catch (_) {
    return null;
  }
}

function isNonLosslessSymbol(symbol, label = "") {
  const text = `${symbol || ""} ${label || ""}`.toLowerCase();
  return /(fee|tax|reflect|rebase|rebasing|elastic|deflat|burn|scaled|shares|staked|vault|token-2022|transferfee)/i.test(text);
}

function candidate(base) {
  const routePositive = Boolean(base.routePositive);
  return {
    ...base,
    routePositive,
    signedActionJustified: false,
    forkGate: base.forkGate || "Fork/local PoC only after a live non-lossless token has material bridge liquidity and balance-delta accounting mismatch.",
  };
}

function scanWormhole() {
  const live = readJson(FILES.wormholeLive, {});
  const feeRefresh = readJson(FILES.wormholeToken2022, null);
  const report = readText(FILES.wormholeReport);
  const results = Array.isArray(live.results) ? live.results : [];
  const scannedChains = results.length;
  const evmCustodyRows = results.flatMap((r) => Array.isArray(r.tokenBridge?.custody) ? r.tokenBridge.custody.map((c) => ({ chain: r.target?.key, ...c })) : []);
  const token2022CustodyAccounts = feeRefresh?.summary?.custodyAccounts ?? extractBacktickNumber(report, "Portal Solana Token-2022 custody accounts");
  const token2022FeeMints = feeRefresh?.summary?.transferFeeConfigMints ?? extractBacktickNumber(report, "Custody mints with `TransferFeeConfig`");
  const activeFeeMints = feeRefresh?.summary?.activeFeeMints ?? null;
  const nonzeroWrappers = feeRefresh?.summary?.nonzeroWrappers ?? null;
  const routePositiveCount = feeRefresh?.summary?.routePositive ?? 0;
  const noPriorityWrappers = feeRefresh ? nonzeroWrappers === 0 : /Priority EVM wrapped assets[\s\S]*None found/i.test(report);
  const nttNotConfigured = results.filter((r) => (r.flags || []).includes("NTT_NOT_CONFIGURED_FOR_SCAN")).length;
  const status = routePositiveCount > 0 ? "fork-gate-candidate" : noPriorityWrappers ? "active-fee-no-priority-wrapper" : "needs-wrapper-liquidity-recheck";

  return candidate({
    id: "wormhole-solana-token2022-portal",
    bridge: "Wormhole Portal",
    surface: "Solana Token-2022 transfer-fee outbound nominal amount vs custody delta",
    status,
    severity: routePositiveCount > 0 ? "HIGH" : "DORMANT",
    score: routePositiveCount > 0 ? 88 : feeRefresh ? 68 : noPriorityWrappers ? 62 : 76,
    evidence: {
      scannedChains,
      evmCustodyRows: evmCustodyRows.length,
      token2022CustodyAccounts,
      token2022FeeMints,
      activeFeeMints,
      priorityEvmWrappersFound: nonzeroWrappers ?? (noPriorityWrappers ? 0 : null),
      routePositive: routePositiveCount,
      feeMints: (feeRefresh?.feeMints || []).map((m) => ({ mint: m.mint, activeFeeBps: m.activeFeeBps, custodyAmount: m.custodyAmount })).slice(0, 12),
      nttNotConfiguredChains: nttNotConfigured,
      sourceArtifacts: ["reports/wormhole-portal-ntt-triage.md", "reports/raw/fast/wormhole-live.json", "reports/raw/fast/wormhole-token2022-fee-wrappers.json"],
    },
    blockers: noPriorityWrappers
      ? ["Active Token-2022 transfer-fee mints have no priority EVM Portal wrappers", "No destination DEX/lending liquidity route exists for the fee mints"]
      : ["Wrapper/liquidity state must be refreshed before PoC"],
    firstReadOnlyChecks: [
      "Re-query Solana Portal Token Bridge custody signer Token-2022 accounts with TransferFeeConfig",
      "For each fee mint, query wrappedAsset(1, mint) on Ethereum/Base/Arbitrum/Optimism/Polygon/BSC",
      "Check DEX/lending liquidity for any nonzero wrapper",
    ],
    routePositiveCriteria: [
      "Token-2022 mint has active transfer fee",
      "Portal emits nominal amount larger than custody balance delta",
      `Destination wrapper has at least $${MATERIAL_USD.toLocaleString()} usable exit or borrow liquidity`,
    ],
    routePositive: false,
  });
}

function scanAxelar() {
  const live = readJson(FILES.axelarLive, {});
  const results = Array.isArray(live.results) ? live.results : [];
  const managers = [];
  const flags = [];
  for (const result of results) {
    const chain = result.target?.key || result.target?.name || "unknown";
    for (const flag of result.flags || []) flags.push(`${chain}:${flag}`);
    for (const tm of result.tokenManagers || []) {
      const managerBalance = humanAmount(tm.tokenInfo?.managerBalance || "0", tm.tokenInfo?.decimals ?? tm.tokenInfo?.decimals);
      const serviceBalance = humanAmount(tm.tokenInfo?.serviceBalance || "0", tm.tokenInfo?.decimals ?? tm.tokenInfo?.decimals);
      const nonLosslessHint = isNonLosslessSymbol(tm.tokenInfo?.symbol || tm.symbol, tm.implementationTypeLabel || tm.type);
      managers.push({
        chain,
        symbol: tm.tokenInfo?.symbol || tm.symbol || null,
        type: tm.type || null,
        implementationTypeLabel: tm.implementationTypeLabel || null,
        tokenAddress: tm.tokenAddress || tm.expectedTokenAddress || null,
        flowLimit: tm.flowLimit || null,
        managerBalance,
        serviceBalance,
        nonLosslessHint,
        valueBearing: (managerBalance || 0) >= MATERIAL_TOKEN_FLOOR || (serviceBalance || 0) >= MATERIAL_TOKEN_FLOOR,
      });
    }
  }
  const suspicious = managers.filter((m) => m.nonLosslessHint && m.valueBearing && !/fee/i.test(m.type || ""));
  const valueBearing = managers.filter((m) => m.valueBearing);

  return candidate({
    id: "axelar-its-cgp-nonlossless",
    bridge: "Axelar ITS/CGP",
    surface: "LOCK_UNLOCK or external gateway token nominal accounting for fee/rebase tokens",
    status: suspicious.length ? "fork-gate-candidate" : "residual-no-live-valuable-manager",
    severity: suspicious.length ? "HIGH" : "DORMANT",
    score: suspicious.length ? 82 : 50,
    evidence: {
      scannedChains: results.length,
      tokenManagers: managers.length,
      valueBearingManagers: valueBearing.length,
      suspiciousManagers: suspicious.length,
      configFlags: flags,
      managers: managers.slice(0, 20),
      sourceArtifacts: ["reports/axelar-gmp-its-triage.md", "reports/raw/fast/axelar-live.json"],
    },
    blockers: suspicious.length
      ? ["Needs route-specific fork/local balance-delta PoC before any execution work"]
      : ["No live valuable fee-on-transfer/rebase LOCK_UNLOCK or CGP external token manager found", "Only current manager flag is non-value HBT drift/zero flow in existing artifact"],
    firstReadOnlyChecks: [
      "Enumerate ITS token managers and classify implementation type vs token behavior",
      "Check manager/service balances, flow limits, and remote liquidity",
      "Check CGP external token registry for fee-on-transfer or rebasing assets",
    ],
    routePositiveCriteria: [
      "Non-lossless token is registered as nominal LOCK_UNLOCK or CGP external token",
      "Custody or remote mint/unlock liquidity is material",
      "Balance-delta simulation shows remote credit exceeds actual received source tokens",
    ],
    routePositive: false,
  });
}

function scanLayerZero() {
  const live = readJson(FILES.layerzeroLive, {});
  const report = readText(FILES.layerzeroReport);
  const results = Array.isArray(live.results) ? live.results : [];
  const chainFlags = [];
  let lzTokenEnabled = 0;
  let singleDeadDvnRoutes = 0;
  let singleLiveDvnRoutes = 0;
  for (const result of results) {
    const chain = result.chain || result.key || result.target?.key || "unknown";
    const localFlags = result.flags || [];
    const deadKeys = new Set(localFlags
      .filter((flag) => /USES_DEAD_DVN/.test(flag))
      .map((flag) => flag.replace("USES_DEAD_DVN", "DVN")));
    for (const flag of result.flags || []) {
      chainFlags.push(`${chain}:${flag}`);
      if (/SINGLE_DVN/.test(flag)) {
        const key = flag.replace("SINGLE_DVN", "DVN");
        if (deadKeys.has(key)) singleDeadDvnRoutes += 1;
        else singleLiveDvnRoutes += 1;
      }
    }
    if (result.endpoint?.lzToken && !/^0x0{40}$/i.test(result.endpoint.lzToken)) lzTokenEnabled += 1;
  }
  const oftResidualDocumented = /OFT adapter accounting drift/i.test(report);

  return candidate({
    id: "layerzero-oftadapter-nonlossless",
    bridge: "LayerZero V2 OFT/OFTAdapter",
    surface: "OFTAdapter lossless-transfer assumption for fee/rebase/callback tokens",
    status: "needs-oft-route-inventory",
    severity: "DORMANT",
    score: singleLiveDvnRoutes ? 66 : 46,
    evidence: {
      scannedChains: results.length,
      oftResidualDocumented,
      lzTokenEnabledChains: lzTokenEnabled,
      singleDeadDvnRoutes,
      singleLiveDvnRoutes,
      chainFlags: chainFlags.slice(0, 40),
      sourceArtifacts: ["reports/layerzero-v2-triage.md", "reports/raw/fast/layerzero-v2-live.json"],
    },
    blockers: [
      "Endpoint-level artifact does not inventory live OFT/OFTAdapter deployments",
      "No high-value non-lossless OFT adapter is currently proven",
      "Scanned endpoints have lzToken fee mode disabled",
    ],
    firstReadOnlyChecks: [
      "Inventory live OFT/OFTAdapter deployments and underlying tokens",
      "Classify underlying token behavior and debit/credit override implementation",
      "Join each route to destination DEX/lending liquidity and DVN config",
    ],
    routePositiveCriteria: [
      "High-value OFTAdapter wraps fee-on-transfer/rebasing/callback token",
      "Adapter does not override debit/credit to balance-delta accounting",
      `Destination route has at least $${MATERIAL_USD.toLocaleString()} liquidity or borrow capacity`,
    ],
    routePositive: false,
  });
}

function scanHyperlane() {
  const warpRoutes = readJson(FILES.hyperlaneWarpRoutes, null);
  const report = readText(FILES.hyperlaneReport);
  const baseSummary = readText(FILES.hyperlaneBaseSummary);
  const fotResidual = /Fee-On-Transfer ERC20 Collateral Can Undercollateralize Warp Routes/i.test(report);
  const erc4626FeeHookResidual = /HypERC4626Collateral.*Fee-Hook/i.test(report);
  const baseMailboxMapped = /Default hook|Required hook|Mailbox/i.test(baseSummary);
  const routePositiveCount = warpRoutes?.summary?.routePositive || 0;
  const reviewCandidates = warpRoutes?.summary?.reviewCandidates || 0;
  const registryFetched = warpRoutes?.summary?.registryFetched || 0;
  const registryTokenCount = warpRoutes?.summary?.registryTokenCount || 0;
  const nonLosslessHintRoutes = warpRoutes?.summary?.nonLosslessHintRoutes || 0;
  const rebaseSpecificRoutes = warpRoutes?.summary?.rebaseSpecificRoutes || 0;
  const valueBearingReviewRoutes = warpRoutes?.summary?.valueBearingReviewRoutes || 0;
  const rebaseRouteChecks = warpRoutes?.summary?.rebaseRouteChecks || 0;
  const rebaseShareMismatchRows = warpRoutes?.summary?.rebaseShareMismatchRows || 0;
  const inventoryReady = Boolean(warpRoutes?.summary);

  return candidate({
    id: "hyperlane-warp-nonlossless-collateral",
    bridge: "Hyperlane Warp Routes",
    surface: "HypERC20Collateral nominal dispatch after safeTransferFrom for non-lossless tokens",
    status: routePositiveCount > 0 ? "fork-gate-candidate" : inventoryReady ? "inventory-no-route-positive" : "needs-warp-route-token-inventory",
    severity: routePositiveCount > 0 ? "HIGH" : "DORMANT",
    score: routePositiveCount > 0 ? 86 : reviewCandidates > 0 ? 64 : fotResidual ? 60 : 35,
    evidence: {
      fotResidualDocumented: fotResidual,
      erc4626FeeHookResidualDocumented: erc4626FeeHookResidual,
      baseMailboxMapped,
      registryFetched,
      registryTokenCount,
      nonLosslessHintRoutes,
      rebaseSpecificRoutes,
      valueBearingReviewRoutes,
      rebaseRouteChecks,
      rebaseShareMismatchRows,
      reviewCandidates,
      topRoutes: (warpRoutes?.topRoutes || []).slice(0, 8).map((r) => ({ routeId: r.routeId, riskScore: r.riskScore, collateralLegs: r.collateralLegs, nonLosslessHints: r.nonLosslessHints, rebaseSpecificHints: r.rebaseSpecificHints, valueBearingReviewHints: r.valueBearingReviewHints, blocker: r.blocker })),
      sourceArtifacts: ["reports/hyperlane-manual-review.md", "reports/hyperlane-base-deployed/onchain-summary.md", "reports/raw/fast/hyperlane-warp-routes.json"],
    },
    blockers: inventoryReady
      ? ["Registry/source classifier is not balance-delta proof", "No locked-collateral vs remote-supply join is present", "No material DEX/lending exit liquidity is attached to any Hyperlane route"]
      : ["Existing artifact samples Mailbox/ISM context, not all live warp collateral routes", "No live high-value non-lossless collateral route is currently proven"],
    firstReadOnlyChecks: [
      "Inventory deployed warp collateral routes and collateral tokens",
      "Classify collateral token transfer behavior from source/code/historical transfer deltas",
      "Compare locked collateral vs remote wrapped supply and route liquidity",
    ],
    routePositiveCriteria: [
      "Warp collateral token is fee-on-transfer/rebasing/deflationary",
      "Router dispatches nominal amount instead of actual balance delta",
      `Remote wrapper has at least $${MATERIAL_USD.toLocaleString()} exit or borrow liquidity`,
    ],
    routePositive: false,
  });
}

function scanDebridge() {
  const balances = readJson(FILES.debridgeBalances, { rows: [] });
  const live = readJson(FILES.debridgeLive, {});
  const rows = Array.isArray(balances.rows) ? balances.rows.map((row) => ({
    ...row,
    humanBalance: humanAmount(row.balanceRaw, row.decimals),
    material: (humanAmount(row.balanceRaw, row.decimals) || 0) >= MATERIAL_TOKEN_FLOOR,
  })) : [];
  const materialRows = rows.filter((row) => row.material);
  const scannedChains = Array.isArray(live.results) ? live.results.length : null;
  const scanErrors = Array.isArray(live.results) ? live.results.filter((r) => /error/i.test(String(r.status || "")) || (r.flags || []).some((f) => /ERROR/.test(f))).length : null;

  return candidate({
    id: "debridge-callproxy-stale-balance",
    bridge: "deBridge DLN/CallProxy",
    surface: "CallProxy uses entire current token/native balance during auto execution",
    status: materialRows.length ? "fork-gate-candidate" : "dust-only",
    severity: materialRows.length ? "HIGH" : "INFO",
    score: materialRows.length ? 75 : 30,
    evidence: {
      scannedChains,
      scanErrors,
      positiveBalanceRows: rows.length,
      materialBalanceRows: materialRows.length,
      balances: rows,
      sourceArtifacts: ["reports/debridge-dln-triage.md", "reports/raw/fast/debridge-callproxy-balances.json", "reports/raw/fast/debridge-live.json"],
    },
    blockers: materialRows.length
      ? ["Needs valid message/external-call fork model before any live consideration"]
      : ["Known live CallProxy balance is dust below fees/gas", "Historical broad token discovery was response-size limited in prior pass"],
    firstReadOnlyChecks: [
      "Expand CallProxy token balance probing using historical asset metadata and PairAdded-like events",
      "Recheck native and known ERC20/deToken balances on all live destination chains",
      "Confirm current CallProxy address from each chain's live gate/DLN config",
    ],
    routePositiveCriteria: [
      "CallProxy holds material stranded native/ERC20/deToken balance",
      "A valid cross-chain submission can route auto execution through CallProxy",
      "Fork shows external call can consume stale balance beyond current submission amount",
    ],
    routePositive: false,
  });
}

function main() {
  const candidates = [
    scanWormhole(),
    scanHyperlane(),
    scanAxelar(),
    scanLayerZero(),
    scanDebridge(),
  ].sort((a, b) => b.score - a.score);

  const watchCandidates = candidates.filter((c) => c.status.includes("candidate") || c.status.includes("recheck")).length;
  const routePositive = candidates.filter((c) => c.routePositive).length;
  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Read-only bridge non-lossless token accounting inventory",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      signedActionJustified: false,
    },
    thresholds: {
      materialUsd: MATERIAL_USD,
      materialTokenFloor: MATERIAL_TOKEN_FLOOR,
    },
    inputs: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.existsSync(file) ? path.relative(WORKSPACE, file) : null])),
    summary: {
      candidates: candidates.length,
      watchCandidates,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      topSurface: candidates[0]?.id || null,
    },
    candidates,
  };
  ensureDir(OUT);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`bridge-nonlossless: candidates=${candidates.length} watch=${watchCandidates} routePositive=${routePositive} top=${out.summary.topSurface}`);
  console.log(`wrote ${path.relative(WORKSPACE, OUT)}`);
}

main();
