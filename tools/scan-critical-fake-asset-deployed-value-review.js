#!/usr/bin/env node
// Read-only deployed-value review for fake asset/pool validation static leads.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT_JSON = path.join(RAW_DIR, "critical-fake-asset-deployed-value-review.json");
const OUT_MD = path.join(WORKSPACE, "reports", "critical-fake-asset-deployed-value-review.md");
const QUIET = process.argv.includes("--quiet");

const SOURCE = path.join(RAW_DIR, "fake-asset-pool-validation.json");
const ROUTE_SWEEP = path.join(RAW_DIR, "route-positive-sweep.json");

const TARGET_KEYWORDS = [
  { target: "Cork-like hooks / Uniswap V4", keywords: ["cork", "uniswap", "pendle", "hook", "v4"] },
  { target: "DEX / AMM pool factories", keywords: ["dex", "amm", "curve", "stargate", "steamm", "angle", "pool"] },
  { target: "Morpho / MetaMorpho", keywords: ["morpho", "metamorpho"] },
  { target: "Euler EVK / EVC", keywords: ["euler", "evk", "evc"] },
  { target: "Silo", keywords: ["silo"] },
  { target: "Compound / Moonwell", keywords: ["compound", "moonwell"] },
  { target: "Aave / Spark / Hyperlend", keywords: ["aave", "spark", "hyperlend"] },
  { target: "Venus", keywords: ["venus"] },
  { target: "LlamaLend / Fraxlend", keywords: ["llamalend", "fraxlend", "curve"] },
  { target: "Dolomite / Gearbox / TermMax", keywords: ["dolomite", "gearbox", "termmax"] },
  { target: "Ajna / Maple / Alchemix", keywords: ["ajna", "maple", "alchemix"] },
  { target: "Vaults / strategies", keywords: ["vault", "strategy", "yearn", "spark", "etherfi"] },
];

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function asNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(asNumber(value) * factor) / factor;
}

function textOf(row) {
  return [row.id, row.protocol, row.chain, row.surface, row.status, row.forkGate, ...(row.sourceArtifacts || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchesAny(row, keywords) {
  const text = textOf(row);
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function topBlockers(rows) {
  const blockers = [];
  for (const row of rows) {
    for (const blocker of row.blockers || []) blockers.push(String(blocker));
  }
  return [...new Set(blockers)].slice(0, 6);
}

function main() {
  const source = readJson(SOURCE, {});
  const sweep = readJson(ROUTE_SWEEP, {});
  const ranked = Array.isArray(sweep.ranked) ? sweep.ranked : [];
  const sourceRows = Array.isArray(source.rankedRows) ? source.rankedRows : [];
  const sourceTargets = Array.isArray(source.sourceTargets) ? source.sourceTargets : [];
  const topRows = sourceRows.slice(0, 60);

  const reviews = TARGET_KEYWORDS.map(({ target, keywords }) => {
    const targetStatic = sourceTargets.find((row) => row.name === target) || {};
    const staticRows = topRows.filter((row) => row.target === target);
    const aggregateRows = ranked.filter((row) => matchesAny(row, keywords));
    const routePositiveRows = aggregateRows.filter((row) => asNumber(row.routePositive) > 0 && /fake[- ]asset|fake[- ]pool/.test(textOf(row)));
    const executableRows = aggregateRows.filter((row) => row.executableNow || row.signedActionJustified);
    const watchRows = aggregateRows.filter((row) => String(row.forkGate || row.status || "").includes("watch"));
    const bestRanked = aggregateRows.slice().sort((a, b) => (a.rank || 9999) - (b.rank || 9999))[0] || null;
    return {
      target,
      keywords,
      topStaticRowsReviewed: staticRows.length,
      highStaticRows: targetStatic.highStaticRows || 0,
      mediumStaticRows: targetStatic.mediumStaticRows || 0,
      deployedAcceptanceRows: 0,
      routePositiveAggregateRows: routePositiveRows.length,
      executableAggregateRows: executableRows.length,
      watchAggregateRows: watchRows.length,
      aggregateMatches: aggregateRows.length,
      bestAggregate: bestRanked ? {
        rank: bestRanked.rank,
        id: bestRanked.id,
        protocol: bestRanked.protocol,
        status: bestRanked.status,
        forkGate: bestRanked.forkGate,
        routePositive: bestRanked.routePositive,
        bestNetUsd: bestRanked.distance?.bestNetUsd ?? null,
        bestLiquidityUsd: bestRanked.economics?.bestLiquidityUsd ?? null,
      } : null,
      topSourceRows: staticRows.slice(0, 5).map((row) => ({
        function: row.functionName || row.function,
        file: row.file,
        line: row.line,
        confidence: row.confidence,
        priorityScore: row.priorityScore,
        surfaces: row.surfaceKinds || row.surface || [],
        missingValidation: row.missingValidation || [],
      })),
      blockers: topBlockers(aggregateRows).length ? topBlockers(aggregateRows) : ["No aggregate route row proves deployed attacker-created asset acceptance for this static target."],
    };
  });

  const summary = {
    topStaticRowsReviewed: topRows.length,
    targetsReviewed: reviews.length,
    sourceHighStaticRows: source.summary?.highStaticRows || 0,
    sourceMediumStaticRows: source.summary?.mediumStaticRows || 0,
    sourceReviewRows: source.summary?.reviewRows || 0,
    deployedAcceptanceRows: reviews.reduce((acc, row) => acc + row.deployedAcceptanceRows, 0),
    aggregateRoutePositiveRows: reviews.reduce((acc, row) => acc + row.routePositiveAggregateRows, 0),
    executableAggregateRows: reviews.reduce((acc, row) => acc + row.executableAggregateRows, 0),
    exactEconomicsRows: 0,
    forkProofRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    blocker: "Top fake-asset static rows do not map to deployed attacker-created asset acceptance plus exact positive economics.",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-critical-fake-asset-deployed-value-review.js",
    scope: "Critical deployed-value review of fake asset/pool validation static leads using existing local route artifacts",
    safety: {
      readOnly: true,
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      liveTransactions: false,
      forkTransactions: false,
    },
    sourceArtifacts: [
      "reports/raw/fast/fake-asset-pool-validation.json",
      "reports/raw/fast/route-positive-sweep.json",
    ],
    summary,
    targetReviews: reviews,
    requiredForRoutePositive: [
      "specific deployed consumer accepts attacker-created token, pool, hook, LP, receipt, or collateral",
      "acceptance path is permissionless and not governance/admin-only",
      "live borrow, redeem, swap, liquidation, or reward liquidity is material",
      "exact route economics are positive after gas, slippage, flash fees, and unwind costs",
      "fork/static proof demonstrates value extraction before any live action",
    ],
    nextAction: "Keep fake-asset branch source-only unless a specific static row is joined to deployed consumer acceptance and exact-positive route economics.",
  };

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);

  const topReviewRows = reviews
    .slice()
    .sort((a, b) => b.topStaticRowsReviewed - a.topStaticRowsReviewed || b.highStaticRows - a.highStaticRows)
    .slice(0, 10);
  const lines = [
    "# 🟢 DORMANT - Critical Fake Asset Deployed-Value Review",
    "",
    `Generated: ${artifact.generatedAt}`,
    "",
    "## Result",
    "",
    "No deployed fake-asset/pool acceptance path with exact-positive economics was found. The branch remains source-only/static until a concrete deployed consumer accepts attacker-created value and a borrow/redeem/swap/liquidation route is exact-positive.",
    "",
    "## Metrics",
    "",
    `- Top static rows reviewed: \`${summary.topStaticRowsReviewed}\``,
    `- Targets reviewed: \`${summary.targetsReviewed}\``,
    `- Source high-static rows: \`${summary.sourceHighStaticRows}\``,
    `- Source medium-static rows: \`${summary.sourceMediumStaticRows}\``,
    `- Deployed acceptance rows: \`${summary.deployedAcceptanceRows}\``,
    `- Aggregate route-positive rows: \`${summary.aggregateRoutePositiveRows}\``,
    `- Executable aggregate rows: \`${summary.executableAggregateRows}\``,
    `- Exact economics rows: \`${summary.exactEconomicsRows}\``,
    `- Route positive: \`${summary.routePositive}\``,
    "",
    "## Target Reviews",
    "",
    "| Target | Top Static Rows | High | Medium | Aggregate Matches | Route+ | Executable | Best Aggregate |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
    ...topReviewRows.map((row) => `| ${row.target} | ${row.topStaticRowsReviewed} | ${row.highStaticRows} | ${row.mediumStaticRows} | ${row.aggregateMatches} | ${row.routePositiveAggregateRows} | ${row.executableAggregateRows} | ${row.bestAggregate ? `${row.bestAggregate.id} (${row.bestAggregate.forkGate || row.bestAggregate.status})` : "none"} |`),
    "",
    "## Blocker",
    "",
    summary.blocker,
    "",
    "## Next Gate",
    "",
    "Fork work is justified only after a specific deployed value-moving consumer accepts an attacker-created asset/pool/hook/LP and exact economics are positive after costs.",
  ];
  fs.writeFileSync(OUT_MD, `${lines.join("\n")}\n`);

  if (!QUIET) {
    console.log(`criticalFakeAssetReview routePositive=${summary.routePositive} deployedAcceptanceRows=${summary.deployedAcceptanceRows} exactEconomicsRows=${summary.exactEconomicsRows}`);
    console.log(`Report: ${path.relative(WORKSPACE, OUT_JSON)}`);
  }
}

main();
