#!/usr/bin/env node
// Consolidated read-only non-borrow drain surface report.
// Normalizes existing scanner outputs and records coverage gaps without opening any execution path.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT_JSON = path.join(RAW, "non-borrow-drain-surface.json");
const OUT_MD = path.join(WORKSPACE, "reports", "non-borrow-drain-surface.md");
const QUIET = process.argv.includes("--quiet");

const ARTIFACTS = {
  erc4626Joiner: artifact("erc4626-consumer-joiner.json", "ERC4626 consumer joiner"),
  e15DonationRoutes: artifact("e15-vault-donation-routes.json", "E15 vault donation routes"),
  newVaultDonation: artifact("new-vault-donation-attack.json", "New vault donation routes"),
  evaultDonationSensitivity: artifact("evault-donation-sensitivity.json", "Euler eVault donation sensitivity"),
  morphoAllocator: artifact("morpho-public-allocator-force-feed.json", "Morpho public allocator force-feed"),
  feeOnTransfer: artifact("fee-on-transfer-rebase.json", "Fee-on-transfer / rebase collateral"),
  bridgeProofBinding: artifact("bridge-proof-binding.json", "Bridge proof binding"),
  bridgeDomainSeparation: artifact("bridge-domain-separation.json", "Bridge domain separation"),
  bridgeEscrowReconciliation: artifact("bridge-escrow-reconciliation.json", "Bridge escrow reconciliation"),
  bridgeNonLosslessCollateralJoin: artifact("bridge-nonlossless-collateral-join.json", "Non-lossless bridge collateral join"),
  bridgeLendingCollateralJoin: artifact("bridge-lending-collateral-join.json", "Bridge lending collateral join"),
  bridgeSyntheticConsumerExposure: artifact("bridge-synthetic-consumer-exposure.json", "Bridge synthetic consumer exposure"),
  routerRfq: artifact("router-rfq-settlement-drift.json", "Router/RFQ settlement drift"),
  routerApproval: artifact("router-approval-drain.json", "Router approval drain"),
  fakeAssetPool: artifact("fake-asset-pool-validation.json", "Fake asset/pool validation"),
  criticalFakeAsset: artifact("critical-fake-asset-deployed-value-review.json", "Critical fake asset deployed-value review"),
  poolShareSnapshot: artifact("pool-share-snapshot-drift.json", "Pool-share snapshot drift"),
  strategyMigrationRebalance: artifact("strategy-migration-rebalance.json", "Strategy migration / rebalance"),
  governanceAttack: artifact("governance-attack-surface.json", "Governance attack surface"),
  governanceListing: artifact("governance-listing-watch.json", "Governance listing watch"),
  governanceTimelock: artifact("governance-timelock-payloads.json", "Governance timelock payloads"),
  signedPayloadReplay: artifact("signed-payload-replay.json", "Signed payload replay"),
  claimDistributorReplay: artifact("claim-distributor-replay.json", "Claim distributor replay"),
  predictionMarketLiveRoutes: artifact("prediction-market-live-routes.json", "Prediction-market live routes"),
  pullOracleTiming: artifact("pull-oracle-timing.json", "Pull-oracle timing"),
  smallCapOracle: artifact("small-cap-oracle-manipulation-routes.json", "Small-cap oracle manipulation routes"),
  staleOracleLiquidity: artifact("stale-oracle-liquidity-candidates.json", "Stale oracle liquidity candidates"),
  oracleStalenessCrossRef: artifact("oracle-staleness-cross-ref.json", "Oracle staleness cross-ref"),
  uniswapTwapConsumers: artifact("uniswap-twap-consumers.json", "Uniswap TWAP consumers"),
  uniswapxMev: artifact("uniswapx-filler-mev.json", "UniswapX filler MEV"),
  uniswapxProfit: artifact("uniswapx-filler-profit.json", "UniswapX filler transfer-profit telemetry"),
  mevSandwichOrderEconomics: artifact("mev-sandwich-order-economics.json", "MEV/sandwich order economics"),
  merkleCrossChainArb: artifact("merkle-cross-chain-arb.json", "Cross-chain price arb telemetry"),
  crossChainSettlementQuotes: artifact("cross-chain-settlement-quotes.json", "Cross-chain settlement quotes"),
};

const SURFACES = [
  {
    id: "erc4626-donation",
    name: "ERC4626 donation / share-price inflation",
    coverage: "covered",
    artifacts: ["newVaultDonation", "erc4626Joiner", "e15DonationRoutes", "evaultDonationSensitivity"],
    routeGraph: "vault/share producer -> lending/oracle/DEX consumer -> borrow/redeem/unwind liquidity",
    currentBlocker: "No low-TVL vault is simultaneously consumer-linked, deposit-open, liquid, and prefork-positive.",
  },
  {
    id: "public-allocator-force-feed",
    name: "Public allocator force-feed / vault reallocation",
    coverage: "covered",
    artifacts: ["morphoAllocator"],
    routeGraph: "public allocator -> forced market capacity -> exact acquisition -> borrow/unwind economics",
    currentBlocker: "Allocator capacity exists, but no exact acquisition overlap or post-allocator positive net route is present.",
  },
  {
    id: "strategy-migration-accounting",
    name: "Strategy migration / rebalance accounting drift",
    coverage: "covered",
    artifacts: ["strategyMigrationRebalance", "poolShareSnapshot", "fakeAssetPool"],
    routeGraph: "strategy/vault accounting -> same-block snapshot or migration state -> redeem/claim/borrow route",
    currentBlocker: "Dedicated strategy migration/rebalance scanner found context rows, but no permissionless same-block accounting drift with joined accepted-value consumer, exact positive economics, or fork/local proof.",
  },
  {
    id: "fee-on-transfer-rebase",
    name: "Fee-on-transfer / rebase token collateral drift",
    coverage: "covered",
    artifacts: ["feeOnTransfer"],
    routeGraph: "non-standard token balance behavior -> consumer accounting/oracle mismatch -> borrow/redeem exit",
    currentBlocker: "No scanned fee/rebase token is currently joined to an extractive collateral route with live divergence.",
  },
  {
    id: "vault-share-price-manipulation",
    name: "Vault share-price manipulation without borrow dependency",
    coverage: "covered",
    artifacts: ["newVaultDonation", "e15DonationRoutes", "poolShareSnapshot"],
    routeGraph: "share-price manipulation -> direct redeem/claim/LP exit or external settlement value",
    currentBlocker: "Direct vault drains remain blocked by closed deposits, low TVL, no share-liquidity pool, or no same-block exit proof.",
  },
  {
    id: "bridge-proof-and-custody",
    name: "Bridge proof/domain/custody bypass",
    coverage: "covered",
    artifacts: ["bridgeProofBinding", "bridgeDomainSeparation", "bridgeEscrowReconciliation", "bridgeNonLosslessCollateralJoin", "bridgeLendingCollateralJoin", "bridgeSyntheticConsumerExposure"],
    routeGraph: "forged/replayed/under-bound bridge message -> mint/unlock/custody delta -> liquid exit or consumer borrow",
    currentBlocker: "Static under-binding rows exist, but no deployed forged proof, liquid mint/unlock, or exact positive economics row exists.",
  },
  {
    id: "router-rfq-settlement",
    name: "Router/RFQ settlement drift and approval drain",
    coverage: "covered",
    artifacts: ["routerRfq", "routerApproval"],
    routeGraph: "signed order/router approval -> mismatched settlement fields or arbitrary value move -> token drain",
    currentBlocker: "No verified field-diff, live approval/escrow reachability, or balance-delta mismatch with exact economics was found.",
  },
  {
    id: "fake-asset-validation",
    name: "Fake asset / fake pool / collateral validation",
    coverage: "covered",
    artifacts: ["fakeAssetPool", "criticalFakeAsset"],
    routeGraph: "attacker-created asset/pool/receipt -> accepted consumer path -> borrow/redeem/settle exit",
    currentBlocker: "Rows are static-source review only; no deployed consumer currently accepts attacker-created assets with exact positive economics.",
  },
  {
    id: "governance-attack",
    name: "Governance listing, timelock, and malicious payload attacks",
    coverage: "covered",
    artifacts: ["governanceAttack", "governanceListing", "governanceTimelock"],
    routeGraph: "governance power/payload -> oracle/LTV/upgrade/listing change -> borrow/drain route",
    currentBlocker: "No high-risk governance row, low-delay payload, active critical payload, or route-positive consumer join is present.",
  },
  {
    id: "airdrop-claim-replay",
    name: "Airdrop / reward / claim replay exploitation",
    coverage: "covered",
    artifacts: ["claimDistributorReplay", "signedPayloadReplay"],
    routeGraph: "claim/signature/reward distributor -> replay or missing consumption state -> token claim/extract",
    currentBlocker: "Dedicated claim scanner found no live row with replayable proof, arbitrary receiver drain, successful no-proof asset movement, exact positive value, or fork/local extraction proof.",
  },
  {
    id: "mev-sandwich-rfq",
    name: "MEV, sandwich, and filler settlement extraction",
    coverage: "covered",
    artifacts: ["mevSandwichOrderEconomics", "uniswapxMev", "uniswapxProfit", "routerRfq"],
    routeGraph: "public settlement/order flow -> filler/sandwich opportunity -> exact decoded profit after gas",
    currentBlocker: "Dedicated MEV/order economics scanner found active UniswapX fill and transfer telemetry, but no decoded order terms, user limit price, auction curve, exact token pricing, sandwich simulation, verified settlement field drift, positive exact economics, or fork/local proof.",
  },
  {
    id: "prediction-market",
    name: "Prediction-market order, collateral, and resolution attacks",
    coverage: "covered",
    artifacts: ["predictionMarketLiveRoutes", "signedPayloadReplay"],
    routeGraph: "prediction order/resolution/collateral contract -> signature, settlement, or oracle fault -> collateral extraction",
    currentBlocker: "Dedicated prediction-market live-route scanner found material Polymarket escrow/context balances, but no adapter USDC.e sweep balance, no no-proof staticcall success, no order/replay/resolution bypass, no exact positive economics, and no fork/local proof.",
  },
  {
    id: "oracle-sandwich-timing",
    name: "Oracle sandwich, stale pull-oracle, and TWAP manipulation",
    coverage: "covered",
    artifacts: ["pullOracleTiming", "smallCapOracle", "staleOracleLiquidity", "oracleStalenessCrossRef", "uniswapTwapConsumers"],
    routeGraph: "stale/manipulable oracle -> consumer value mismatch -> borrow/liquidate/redeem route",
    currentBlocker: "Stale pull-oracle rows exist, but no joined consumer with live borrow/redeem liquidity and exact positive economics is open.",
  },
  {
    id: "cross-chain-price-bridge-arb",
    name: "Cross-chain price / bridge settlement arbitrage",
    coverage: "covered",
    artifacts: ["crossChainSettlementQuotes", "merkleCrossChainArb", "bridgeProofBinding", "bridgeDomainSeparation"],
    routeGraph: "cross-chain price or settlement delta -> bridge/DEX transfer -> realizable same-capital profit",
    currentBlocker: "Dedicated cross-chain settlement quote scanner found fresh Socket quote metadata and bridge context, but no concrete mismatch or price discrepancy joined to exact positive economics, finality/fee-adjusted route proof, or fork/local extraction proof.",
  },
];

function artifact(file, label) {
  return { file: path.join(RAW, file), label };
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { parseError: String(err && err.message ? err.message : err) };
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function bool(value) {
  if (typeof value === "boolean") return value;
  const n = asNumber(value);
  return n !== null ? n > 0 : false;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function firstDefined(...values) {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return null;
}

function derivedSummary(json) {
  if (!json || json.parseError) return {};
  const base = json.summary && typeof json.summary === "object" ? { ...json.summary } : {};

  if (Array.isArray(json.results)) {
    base.results = firstDefined(base.results, json.results.length);
    base.highRiskRows = firstDefined(base.highRiskRows, json.results.filter((r) => String(r.risk || "").toUpperCase().includes("HIGH")).length);
    base.deployedRows = firstDefined(base.deployedRows, json.results.filter((r) => r.deployed === true).length);
  }
  if (json.byReactor && typeof json.byReactor === "object") {
    const reactors = Object.values(json.byReactor);
    base.reactors = reactors.length;
    base.fillEvents = reactors.reduce((acc, r) => acc + (asNumber(r.fillEvents) || 0), 0);
    base.uniqueFillers = reactors.reduce((acc, r) => acc + (asNumber(r.uniqueFillers) || 0), 0);
  }
  if (Array.isArray(json.results) && json.results.some((r) => r.risk || r.error)) {
    base.highStaleRows = firstDefined(base.highStaleRows, json.results.filter((r) => String(r.risk || "").toUpperCase().includes("HIGH")).length);
    base.oracleResponses = firstDefined(base.oracleResponses, json.results.filter((r) => !r.error).length);
  }
  if (json.fillsAnalyzed !== undefined) {
    base.fillsAnalyzed = json.fillsAnalyzed;
    base.totalNet = json.totalNet;
    base.note = "transfer-based telemetry only; not exact route economics";
  }
  return base;
}

function metric(summary, keys) {
  for (const key of keys) {
    const value = asNumber(summary[key]);
    if (value !== null) return value;
  }
  return 0;
}

function loadArtifacts() {
  const loaded = {};
  for (const [key, meta] of Object.entries(ARTIFACTS)) {
    const json = readJson(meta.file);
    const summary = derivedSummary(json);
    const routePositive = Math.max(
      metric(summary, ["routePositive", "preforkDonationPositive", "preforkAllocatorPositive"]),
      bool(json && json.safety && json.safety.routePositive) ? 1 : 0,
    );
    const executableNow = metric(summary, ["executableNow", "executablenow", "executable"]);
    const watchCandidates = metric(summary, ["watchCandidates", "watch", "watchRows"]);
    const reviewRows = metric(summary, ["highStaticRows", "mediumStaticRows", "reviewRows", "proofRows", "validationRows", "snapshotRows", "signatureRows", "highStaleRows"]);

    loaded[key] = {
      key,
      label: meta.label,
      path: rel(meta.file),
      exists: Boolean(json),
      parseError: json && json.parseError ? json.parseError : null,
      generatedAt: json ? firstDefined(json.generatedAt, json.scannedAt, json.timestamp) : null,
      scanner: json ? firstDefined(json.scanner, path.basename(meta.file)) : null,
      safety: json && json.safety ? json.safety : null,
      summary,
      routePositive,
      executableNow,
      watchCandidates,
      reviewRows,
      signedActionJustified: bool(firstDefined(summary.signedActionJustified, json && json.signedActionJustified, json && json.safety && json.safety.signedActionJustified)),
      blocker: summary.blocker || null,
    };
  }
  return loaded;
}

function summarizeSurface(surface, loaded) {
  const artifacts = surface.artifacts.map((key) => loaded[key]).filter(Boolean);
  const present = artifacts.filter((a) => a.exists && !a.parseError);
  const missing = artifacts.filter((a) => !a.exists || a.parseError).map((a) => a.path);
  const routePositive = present.reduce((acc, a) => acc + (asNumber(a.routePositive) || 0), 0);
  const executableNow = present.reduce((acc, a) => acc + (asNumber(a.executableNow) || 0), 0);
  const watchCandidates = present.reduce((acc, a) => acc + (asNumber(a.watchCandidates) || 0), 0);
  const reviewRows = present.reduce((acc, a) => acc + (asNumber(a.reviewRows) || 0), 0);
  const signedActionJustified = present.some((a) => a.signedActionJustified);
  const coverageStatus = present.length === 0 ? "gap" : surface.coverage;
  const signal = routePositive > 0 || executableNow > 0 || signedActionJustified
    ? "route-positive-gate-open"
    : coverageStatus === "gap"
      ? "coverage-gap"
      : coverageStatus === "partial-gap"
        ? "partial-coverage-route-negative"
        : "covered-route-negative";

  return {
    id: surface.id,
    name: surface.name,
    coverage: coverageStatus,
    signal,
    routeGraph: surface.routeGraph,
    currentBlocker: routePositive > 0 ? "Route-positive artifact requires manual review before any fork or signed action." : surface.currentBlocker,
    gap: surface.gap || null,
    artifacts: artifacts.map((a) => ({
      key: a.key,
      label: a.label,
      path: a.path,
      exists: a.exists,
      generatedAt: a.generatedAt,
      routePositive: a.routePositive,
      executableNow: a.executableNow,
      watchCandidates: a.watchCandidates,
      reviewRows: a.reviewRows,
      blocker: a.blocker,
    })),
    missingArtifacts: missing,
    metrics: {
      artifactsPresent: present.length,
      artifactsExpected: artifacts.length,
      routePositive,
      executableNow,
      watchCandidates,
      reviewRows,
      signedActionJustified,
    },
  };
}

function buildMarkdown(out) {
  const lines = [];
  lines.push("# Non-Borrow Drain Surface");
  lines.push("");
  lines.push(`Generated: ${out.generatedAt}`);
  lines.push("");
  lines.push("Signal: No confirmed permissionless non-borrow drain or route-positive extraction path.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Surfaces: ${out.summary.surfaces}`);
  lines.push(`- Covered: ${out.summary.covered}`);
  lines.push(`- Partial coverage gaps: ${out.summary.partialGaps}`);
  lines.push(`- Full gaps: ${out.summary.fullGaps}`);
  lines.push(`- Route-positive surfaces: ${out.summary.routePositiveSurfaces}`);
  lines.push(`- Executable-now surfaces: ${out.summary.executableNowSurfaces}`);
  lines.push(`- Signed action justified: ${out.summary.signedActionJustified}`);
  lines.push("");
  lines.push("## Surface Matrix");
  lines.push("");
  lines.push("| Surface | Coverage | Signal | Route-positive | Watch | Review rows | Blocker |");
  lines.push("|---|---:|---|---:|---:|---:|---|");
  for (const row of out.surfaces) {
    lines.push(`| ${escapeCell(row.name)} | ${row.coverage} | ${row.signal} | ${row.metrics.routePositive} | ${row.metrics.watchCandidates} | ${row.metrics.reviewRows} | ${escapeCell(row.currentBlocker)} |`);
  }
  lines.push("");
  lines.push("## Gaps");
  lines.push("");
  const gaps = out.surfaces.filter((s) => s.gap || s.coverage === "gap");
  if (!gaps.length) {
    lines.push("No explicit coverage gaps recorded.");
  } else {
    for (const gap of gaps) lines.push(`- ${gap.name}: ${gap.gap || "No artifact present."}`);
  }
  lines.push("");
  lines.push("## Artifact Inputs");
  lines.push("");
  lines.push("| Artifact | Present | Route-positive | Watch | Review rows | Generated |");
  lines.push("|---|---:|---:|---:|---:|---|");
  for (const a of Object.values(out.artifacts)) {
    lines.push(`| ${escapeCell(a.path)} | ${a.exists ? "yes" : "no"} | ${a.routePositive} | ${a.watchCandidates} | ${a.reviewRows} | ${a.generatedAt || "n/a"} |`);
  }
  lines.push("");
  lines.push("## Gate");
  lines.push("");
  lines.push("No signed action is authorized by this report. Fork work remains closed unless a route-positive row is paired with exact live economics and a local fork/static-call proof.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function escapeCell(value) {
  return String(value === null || value === undefined ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function main() {
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });

  const artifacts = loadArtifacts();
  const surfaces = SURFACES.map((surface) => summarizeSurface(surface, artifacts));
  const routePositiveSurfaces = surfaces.filter((s) => s.metrics.routePositive > 0).length;
  const executableNowSurfaces = surfaces.filter((s) => s.metrics.executableNow > 0).length;
  const signedActionJustified = surfaces.some((s) => s.metrics.signedActionJustified);
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-non-borrow-drain-surface.js",
    scope: "Consolidated non-borrow drain surface coverage and gate report across existing read-only scanners",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositiveSurfaces > 0,
      signedActionJustified,
    },
    summary: {
      surfaces: surfaces.length,
      covered: surfaces.filter((s) => s.coverage === "covered").length,
      partialGaps: surfaces.filter((s) => s.coverage === "partial-gap").length,
      fullGaps: surfaces.filter((s) => s.coverage === "gap").length,
      routePositiveSurfaces,
      routePositive: surfaces.reduce((acc, s) => acc + s.metrics.routePositive, 0),
      executableNowSurfaces,
      executableNow: surfaces.reduce((acc, s) => acc + s.metrics.executableNow, 0),
      watchCandidates: surfaces.reduce((acc, s) => acc + s.metrics.watchCandidates, 0),
      reviewRows: surfaces.reduce((acc, s) => acc + s.metrics.reviewRows, 0),
      signedActionJustified,
      blocker: routePositiveSurfaces > 0
        ? "At least one route-positive input exists; inspect linked artifacts before any fork or signed action."
        : "No non-borrow surface currently has route-positive, executable-now, or signed-action justification.",
    },
    surfaces,
    gaps: surfaces.filter((s) => s.gap || s.coverage === "gap").map((s) => ({ id: s.id, name: s.name, gap: s.gap || "No artifact present." })),
    artifacts,
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, buildMarkdown(out));

  if (!QUIET) {
    console.log(`Non-borrow drain surface: surfaces=${out.summary.surfaces} covered=${out.summary.covered} partialGaps=${out.summary.partialGaps} routePositive=${out.summary.routePositive} executableNow=${out.summary.executableNow}`);
    console.log(`Report: ${rel(OUT_JSON)}`);
  }
}

main();
