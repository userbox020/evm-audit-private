#!/usr/bin/env node
// scan-pt-oracle-semantic-gaps.js - artifact/source-only PT oracle semantic-gap enrichment.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  ptUnitMismatch: path.join(WORKSPACE, "reports", "raw", "fast", "pt-oracle-unit-mismatch.json"),
  siloRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "silo-pt-oracle-routes.json"),
  pendleConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-consumer-graph.json"),
  falconProbe: path.join(WORKSPACE, "reports", "raw", "fast", "falcon-silo-pt-oracle-route.json"),
};

const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "pt-oracle-semantic-gaps.json");
const OUT_MD = path.join(WORKSPACE, "reports", "pt-oracle-semantic-gaps-triage.md");
const MATERIAL_LIQUIDITY_USD = 10_000;

const SOURCE_FACTS = [
  {
    id: "siloPTLinear.latestRoundDataAnswerDecimals",
    file: "targets/silo-contracts-v2/silo-oracles/contracts/pendle/linear/PTLinearOracle.sol",
    lines: "35-38",
    statement: "PTLinearOracle.latestRoundData returns `answer` in 18-decimal format, not Chainlink's 8-decimals convention.",
    snippet:
      "/// return value is in 18 decimals, not 8 like in chainlink\nreturn (0, answer, 0, 0, 0);",
  },
  {
    id: "siloPTLinear.normalizationRequired",
    file: "targets/silo-contracts-v2/silo-oracles/contracts/pendle/linear/PTLinearOracleConfig.sol",
    lines: "13-14",
    statement: "PT linear oracle normalization divider is required to be `10 ** tokenDecimals` of the PT token.",
    snippet: "/// @dev Normalization divider, must be 10 ** tokenDecimals of ptToken\nuint256 internal immutable _NORMALIZATION_DIVIDER;",
  },
  {
    id: "siloPTLinear.quoteFormula",
    file: "targets/silo-contracts-v2/silo-oracles/contracts/pendle/linear/PTLinearOracle.sol",
    lines: "98-111",
    statement: "Silo PT linear quote formula is `quoteAmount = _baseAmount * ptLinearPrice / normalizationDivider`.",
    snippet: "uint256 ptLinearPrice = ...latestRoundData();\nquoteAmount = _baseAmount * uint256(ptLinearPrice) / cfg.normalizationDivider;",
  },
  {
    id: "siloPTLinear.rateHandling",
    file: "targets/silo-contracts-v2/silo-oracles/contracts/pendle/PendlePTOracle.sol",
    lines: "94-103",
    statement: "Pendle PT oracle applies `PtToSyRate` and switches precision handling when rate is above/below 1e18.",
    snippet:
      "// rate can be more than 10**18 when decimals differ\n" +
      "if (rate <= PENDLE_RATE_PRECISION) {\n" +
      "  quoteAmount = UNDERLYING_ORACLE.quote(_baseAmount, PT_UNDERLYING_TOKEN);\n" +
      "} else {\n" +
      "  underlyingAmount = Math.mulDiv(_baseAmount, rate, PENDLE_RATE_PRECISION);\n" +
      "}",
  },
  {
    id: "eulerPendle.scaleHandling",
    file: "targets/euler-oracle/src/adapter/pendle/PendleUniversalOracle.sol",
    lines: "24-25,87-100",
    statement: "PendleUniversalOracle stores FEED_DECIMALS=18 and computes scaling via ScaleUtils before output conversion.",
    snippet: "uint8 internal constant FEED_DECIMALS = 18;\n...\nscale = ScaleUtils.calcScale(baseDecimals, quoteDecimals, FEED_DECIMALS);\nreturn ScaleUtils.calcOutAmount(inAmount, unitPrice, scale, inverse);",
  },
  {
    id: "eulerScaleUtils.calcScale",
    file: "targets/euler-oracle/src/lib/ScaleUtils.sol",
    lines: "53-76",
    statement: "ScaleUtils computes decimal conversion with `calcScale(baseDecimals, quoteDecimals, feedDecimals)` and applies `calcOutAmount(...)`.",
    snippet: "function calcScale(uint8 baseDecimals, uint8 quoteDecimals, uint8 feedDecimals) { return from(quoteDecimals, feedDecimals + baseDecimals); }\nfunction calcOutAmount(...) { ... if (inverse) {inAmount * feedScale / (priceScale*unitPrice)} else {inAmount*priceScale*unitPrice/feedScale}}",
  },
];

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function normAddress(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(text) ? text : null;
}

function normText(value) {
  return String(value || "").trim().toLowerCase();
}

function sourceRel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function toRows(rows, count = 0) {
  return Array.isArray(rows) ? rows.slice(0, count || rows.length) : [];
}

function containsMissingReference(blockers, row) {
  const text = [
    ...(blockers || []),
    row.publicPtUsd === null ? "no public price" : "",
    row.quoteAcquisitionUsdPerPt === null ? "no acquisition price" : "",
    row.publicPtUsd === null && row.quoteAcquisitionUsdPerPt === null ? "no executable PT price reference" : "",
  ].join(" ").toLowerCase();

  return /no public or executable pt price reference|no public pt price|no public\s*price reference|no acquisition|no public\s*or\s*executable|no exact quote/.test(text);
}

function hasConfigDecodeAmbiguity(falconMatch) {
  return normText(falconMatch?.oracle?.configDecodeStatus).includes("unexpected-wrapper-or-abi-mismatch");
}

function chooseFactsForSource(source, row) {
  if (source === "silo-pt-oracle-routes") {
    return [
      "siloPTLinear.latestRoundDataAnswerDecimals",
      "siloPTLinear.normalizationRequired",
      "siloPTLinear.quoteFormula",
      "siloPTLinear.rateHandling",
    ];
  }
  if (source === "pendle-pt-consumer-graph" || source === "morpho-high-apy-liquidation-routes") {
    return [
      "siloPTLinear.rateHandling",
      "eulerPendle.scaleHandling",
      "eulerScaleUtils.calcScale",
    ];
  }
  if (row?.side === "liquidation-exit") {
    return [
      "siloPTLinear.rateHandling",
      "eulerPendle.scaleHandling",
      "eulerScaleUtils.calcScale",
    ];
  }

  return [
    "siloPTLinear.latestRoundDataAnswerDecimals",
    "siloPTLinear.normalizationRequired",
    "siloPTLinear.rateHandling",
    "eulerPendle.scaleHandling",
    "eulerScaleUtils.calcScale",
  ];
}

function economicsStatus(row, hasMissingReference) {
  const net = asNumber(row.netEdgeUsd);
  const gap = asNumber(row.breakEvenGapBps);
  const liquidity = asNumber(row.borrowCapacityUsd ?? row.oppositeLiquidityUsd ?? row.borrowLiquidityUsd) || 0;

  if (net !== null && net < 0) return "exact-negative";
  if (hasMissingReference) return "no-exact-quote";
  if (gap !== null && gap > 0) return "below-break-even";
  if (liquidity > 0 && liquidity < MATERIAL_LIQUIDITY_USD) return "dust-liquidity";
  return "unknown";
}

function semanticStatus(row, hasMissingRef, hasFalconAmbiguity) {
  if (hasFalconAmbiguity) return "config-decode-ambiguous";
  if (hasMissingRef) return "missing-market-or-reference";
  if ((row.blockers || []).some((b) => /oracle quote unavailable/i.test(String(b)))) return "oracle-quote-unavailable";
  if (row.source === "silo-pt-oracle-routes" || row.source === "pendle-pt-consumer-graph" || row.source === "morpho-high-apy-liquidation-routes") {
    return "semantics-source-backed";
  }
  if (asNumber(row.netEdgeUsd) !== null && asNumber(row.netEdgeUsd) < 0) return "economics-negative";
  return "blocked";
}

function unitMismatchProofStatus(row, hasFalconAmbiguity) {
  if (hasFalconAmbiguity) return "unproven";
  if (row.source === "silo-pt-oracle-routes" || row.source === "pendle-pt-consumer-graph" || row.source === "morpho-high-apy-liquidation-routes") {
    return "contradicted-by-source";
  }
  return "unproven";
}

function severityEconomics(status) {
  return {
    "exact-negative": 4,
    "below-break-even": 3,
    "dust-liquidity": 2,
    "unknown": 1,
    "no-exact-quote": 0,
  }[status] ?? 0;
}

function severitySemantic(status) {
  return {
    "config-decode-ambiguous": 2,
    "missing-market-or-reference": 3,
    "oracle-quote-unavailable": 2,
    "semantics-source-backed": 1,
    "economics-negative": 1,
    "blocked": 0,
  }[status] ?? 0;
}

function countBy(list, getter) {
  const map = {};
  for (const item of list) {
    const key = getter(item);
    if (!key) continue;
    map[key] = (map[key] || 0) + 1;
  }
  return map;
}

function pickTop(list, field, limit = 10) {
  return list
    .slice()
    .sort((a, b) => {
      const se = severityEconomics(b.economicsStatus) - severityEconomics(a.economicsStatus);
      if (se !== 0) return se;
      const ss = severitySemantic(b.semanticStatus) - severitySemantic(a.semanticStatus);
      if (ss !== 0) return ss;
      const bNet = asNumber(b.netEdgeUsd);
      const aNet = asNumber(a.netEdgeUsd);
      if (bNet !== null && aNet !== null) return aNet - bNet;
      if (bNet !== null) return -1;
      if (aNet !== null) return 1;
      return 0;
    })
    .slice(0, limit)
    .map((row, index) => ({
      rank: index + 1,
      ...row,
    }));
}

function buildIndexByKey(items, keySelector) {
  const map = new Map();
  for (const item of toRows(items)) {
    const key = keySelector(item);
    if (!key) continue;
    map.set(key, item);
  }
  return map;
}

function buildSourceIndexes() {
  const unit = readJson(FILES.ptUnitMismatch, {});
  const silo = readJson(FILES.siloRoutes, {});
  const pendle = readJson(FILES.pendleConsumerGraph, {});
  const falcon = readJson(FILES.falconProbe, {});

  const siloRows = toRows(silo.rows);
  const pendleRows = toRows(pendle.matches);

  const siloByMarket = buildSourceIndexesByField(siloRows, "id", (x) => ("" + (x.id || x.deploymentKey || "")).toLowerCase());
  const siloByPt = buildSourceIndexesByField(siloRows, "ptToken", (x) => normAddress(x.ptToken || x.pt?.address));

  const pendleByMarket = buildSourceIndexesByField(pendleRows, "market.marketId", (x) => (normText(x.market?.marketId)));
  const pendleByPt = buildSourceIndexesByField(pendleRows, "market.collateralAsset.address", (x) => normAddress(x.market?.collateralAsset?.address || x.producer?.address));

  const falconPt = normAddress(falcon?.addresses?.pt || falcon?.oracle?.config?.ptToken || falcon?.silo?.ptSide?.token);
  const falconByPt = new Map();
  if (falconPt) falconByPt.set(falconPt, falcon);

  return {
    unit,
    silo,
    pendle,
    falcon,
    siloByMarket,
    siloByPt,
    pendleByMarket,
    pendleByPt,
    falconByPt,
  };
}

function buildSourceIndexesByField(items, label, keySelector) {
  const map = new Map();
  for (const item of items) {
    const key = keySelector(item);
    if (!key) continue;
    map.set(key, { item, label });
  }
  return map;
}

function safeText(value, fallback = null) {
  const text = value === null || value === undefined ? fallback : String(value);
  return text === "" ? fallback : text;
}

function formatBps(value) {
  const n = asNumber(value);
  if (n === null) return "n/a";
  return `${round(n, 2)} bps`;
}

function formatMoney(value) {
  const n = asNumber(value);
  if (n === null) return "n/a";
  return `$${round(n, 2)}`;
}

function markdownTable(rows, headers) {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${headers.map((h) => row[h] ?? "").join(" | ")} |`);
  }
  return lines.join("\n");
}

function main() {
  const { unit, silo, pendle, falcon, siloByMarket, siloByPt, pendleByMarket, pendleByPt, falconByPt } = buildSourceIndexes();

  const unitTopRows = toRows(unit.topRows);
  const baseRows = unitTopRows.length > 0
    ? unitTopRows
    : toRows(unit.routePositiveRows);

  const enrichedRows = baseRows.map((row) => {
    const source = safeText(row.source, "").trim();
    const marketId = safeText(row.marketId);
    const ptAddress = normAddress(row.ptAddress);

    const linkedSilo = source === "silo-pt-oracle-routes"
      ? (siloByMarket.get(normText(marketId))?.item || siloByPt.get(ptAddress)?.item || null)
      : null;

    const linkedPendle = (source === "pendle-pt-consumer-graph" || source === "morpho-high-apy-liquidation-routes")
      ? (pendleByMarket.get(normText(marketId))?.item || pendleByPt.get(ptAddress)?.item || null)
      : null;

    const falconMatch = ptAddress ? (falconByPt.get(ptAddress) || null) : null;
    const hasFalconConfigAmbiguity = hasConfigDecodeAmbiguity(falconMatch);

    const missingRef = containsMissingReference(row.blockers, row);
    const eStatus = economicsStatus(row, missingRef);
    const sStatus = semanticStatus(row, missingRef, hasFalconConfigAmbiguity);
    const unitProof = unitMismatchProofStatus(row, hasFalconConfigAmbiguity);
    const facts = chooseFactsForSource(source, row);
    const blockers = Array.isArray(row.blockers) ? row.blockers.slice() : [];
    const liquidity = asNumber(row.borrowCapacityUsd ?? row.oppositeLiquidityUsd ?? row.borrowLiquidityUsd) || 0;
    const materiality = liquidity >= MATERIAL_LIQUIDITY_USD;
    const exactExecutableQuote = Boolean(row.exactAcquisitionQuote || row.exactExitQuote) && !missingRef;
    const acceptedValueAboveBreakEven = asNumber(row.breakEvenGapBps) !== null && asNumber(row.breakEvenGapBps) <= 0;
    const exactPositiveEconomics = asNumber(row.netEdgeUsd) !== null && asNumber(row.netEdgeUsd) > 0;

    if (missingRef && blockers.every((item) => !/missing/.test(String(item).toLowerCase()))) {
      blockers.push("Missing public or executable PT market reference in source artifacts");
    }
    if (hasFalconConfigAmbiguity) {
      blockers.push(`Falcon-focused config decode ambiguity: ${falconMatch?.oracle?.configDecodeStatus || "unexpected-wrapper-or-abi-mismatch"}`);
    }
    if (unitProof === "contradicted-by-source") {
      blockers.push("Local Silo/Euler/Pendle source semantics contradict a simple decimal/unit mismatch proof");
    }
    if (!materiality) blockers.push("borrow/opposite liquidity below material threshold");
    if (!exactExecutableQuote) blockers.push("no exact executable acquisition or exit quote path");
    if (!acceptedValueAboveBreakEven) blockers.push("accepted value does not clear LTV/LLTV break-even premium");
    if (!exactPositiveEconomics) blockers.push("exact positive economics absent");
    blockers.push("fork/local extraction proof absent");

    return {
      ...row,
      sourceFacts: facts,
      semanticStatus: sStatus,
      unitMismatchProof: unitProof,
      economicsStatus: eStatus,
      materiality,
      routeGate: {
        consumerMaterial: materiality,
        semanticUnitBugProof: unitProof === "proven",
        executableAcquisitionOrExit: exactExecutableQuote,
        acceptedValueAboveBreakEven,
        exactPositiveEconomics,
        forkOrLocalProof: false,
        routePositive: false,
      },
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      sourceLinks: {
        sourceFamily: source,
        linksToSiloRoute: linkedSilo
          ? {
              marketId: linkedSilo.id || null,
              name: linkedSilo.name || null,
              debtOracle: linkedSilo.oracle?.address || null,
              configAddress: linkedSilo.oracle?.oracleConfig || null,
            }
          : null,
        linksToPendleConsumerMatch: linkedPendle
          ? {
              marketId: linkedPendle.market?.marketId || null,
              protocol: linkedPendle.protocol || null,
              loanSymbol: linkedPendle.market?.loanAsset?.symbol || null,
              collateralSymbol: linkedPendle.market?.collateralAsset?.symbol || null,
              marketOracle: linkedPendle.market?.oracle?.address || null,
              routePositive: Boolean(linkedPendle.routePositive),
            }
          : null,
        linksToFalconProbe: falconMatch
          ? {
              oracleAddress: falconMatch.oracle?.address || null,
              configDecodeStatus: falconMatch.oracle?.configDecodeStatus || null,
              rawDecodedConfig: {
                linearOracle: falconMatch.oracle?.rawDecodedConfig?.linearOracle || null,
                normalizationDivider: falconMatch.oracle?.rawDecodedConfig?.normalizationDivider || null,
                ptToken: falconMatch.oracle?.rawDecodedConfig?.ptToken || null,
              },
            }
          : null,
      },
      blockers,
    };
  });

  const semanticCounts = countBy(enrichedRows, (row) => row.semanticStatus);
  const economicsCounts = countBy(enrichedRows, (row) => row.economicsStatus);
  const sourceCounts = countBy(enrichedRows, (row) => row.source);
  const unitProofCounts = countBy(enrichedRows, (row) => row.unitMismatchProof);

  const acceptedAcqMax = round(Math.max(...enrichedRows.map((row) => asNumber(row.acceptedVsAcquisitionBps) || Number.NEGATIVE_INFINITY)), 4);
  const acceptedPublicMax = round(Math.max(...enrichedRows.map((row) => asNumber(row.acceptedVsPublicBps) || Number.NEGATIVE_INFINITY)), 4);
  const minBreakEven = round(Math.min(...enrichedRows.map((row) => asNumber(row.breakEvenGapBps) || Number.POSITIVE_INFINITY)), 4);
  const bestNet = round(Math.max(...enrichedRows.map((row) => asNumber(row.netEdgeUsd) || Number.NEGATIVE_INFINITY)), 2);

  const topRows = enrichedRows.map((row) => ({
    ...row,
    acceptedVsAnyBps: row.acceptedVsAcquisitionBps ?? row.acceptedVsPublicBps,
  }));

  const topBlockedRows = pickTop(topRows, null, 10).map((row) => ({
    source: row.source,
    protocol: row.protocol,
    chain: row.chain,
    ptSymbol: row.ptSymbol,
    loanSymbol: row.loanSymbol,
    materiality: row.materiality,
    semanticStatus: row.semanticStatus,
    unitMismatchProof: row.unitMismatchProof,
    economicsStatus: row.economicsStatus,
    acceptedVsAcquisitionBps: row.acceptedVsAcquisitionBps ?? null,
    acceptedVsPublicBps: row.acceptedVsPublicBps ?? null,
    breakEvenGapBps: row.breakEvenGapBps ?? null,
    borrowCapacityUsd: row.borrowCapacityUsd ?? row.oppositeLiquidityUsd ?? null,
    netEdgeUsd: row.netEdgeUsd ?? null,
    topBlockers: (row.blockers || []).slice(0, 4),
  }));

  const summary = {
    rows: enrichedRows.length,
    topRows: topRows.length,
    materialRows: enrichedRows.filter((row) => row.materiality).length,
    semanticSourceBackedRows: enrichedRows.filter((row) => row.semanticStatus === "semantics-source-backed").length,
    unitMismatchProvenRows: enrichedRows.filter((row) => row.unitMismatchProof === "proven").length,
    unitMismatchContradictedRows: enrichedRows.filter((row) => row.unitMismatchProof === "contradicted-by-source").length,
    configAmbiguousRows: enrichedRows.filter((row) => row.semanticStatus === "config-decode-ambiguous").length,
    noReferenceRows: enrichedRows.filter((row) => row.semanticStatus === "missing-market-or-reference").length,
    exactNegativeRows: enrichedRows.filter((row) => row.economicsStatus === "exact-negative").length,
    belowBreakEvenRows: enrichedRows.filter((row) => row.economicsStatus === "below-break-even").length,
    sourceRowsUsed: {
      unitTopRows: unitTopRows.length,
      unitRoutePositiveFallback: unitTopRows.length > 0 ? 0 : toRows(unit.routePositiveRows).length,
    },
    sourceCounts,
    semanticCounts,
    economicsCounts,
    unitProofCounts,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    blockedBySource: [
      "Missing public or executable PT reference",
      "Decimal/scale mismatch proof absent or contradicted by local source semantics",
      "No exact executable acquisition/exit quote path present in current rows",
    ],
    maxAcceptedVsAcquisitionBps: Number.isFinite(acceptedAcqMax) ? acceptedAcqMax : null,
    maxAcceptedVsPublicBps: Number.isFinite(acceptedPublicMax) ? acceptedPublicMax : null,
    minBreakEvenGapBps: Number.isFinite(minBreakEven) ? minBreakEven : null,
    bestNetEdgeUsd: Number.isFinite(bestNet) ? bestNet : null,
    topBlockedRows,
  };

  const topRowsForMd = pickTop(topRows, null, 10).map((row) => ({
    Rank: row.rank,
    Source: row.source,
    Protocol: row.protocol,
    Chain: row.chain,
    PT: row.ptSymbol,
    Loan: row.loanSymbol,
    Semantic: row.semanticStatus,
    "Unit proof": row.unitMismatchProof,
    Economics: row.economicsStatus,
    "Accepted bps": formatBps(row.acceptedVsAnyBps),
    "Gap bps": formatBps(row.breakEvenGapBps),
    "Net edge": formatMoney(row.netEdgeUsd),
    "Top blocker": safeText((row.blockers || [])[0], "n/a"),
  }));

  const md = [
    "# 🟢 DORMANT — PT Oracle Semantic Gap Triage",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Scanner: tools/scan-pt-oracle-semantic-gaps.js`,
    "",
    "## Summary",
    markdownTable([
      { Metric: "Rows", Value: summary.rows },
      { Metric: "Source rows used", Value: summary.sourceRowsUsed.unitTopRows || summary.sourceRowsUsed.unitRoutePositiveFallback },
      { Metric: "Silo source rows", Value: sourceCounts["silo-pt-oracle-routes"] || 0 },
      { Metric: "Pendle consumer rows", Value: sourceCounts["pendle-pt-consumer-graph"] || 0 },
      { Metric: "Morpho liquidation rows", Value: sourceCounts["morpho-high-apy-liquidation-routes"] || 0 },
      { Metric: "Material rows", Value: summary.materialRows },
      { Metric: "Semantic source-backed rows", Value: summary.semanticSourceBackedRows },
      { Metric: "Unit mismatch proven rows", Value: summary.unitMismatchProvenRows },
      { Metric: "Unit mismatch contradicted rows", Value: summary.unitMismatchContradictedRows },
      { Metric: "Missing-reference rows", Value: summary.noReferenceRows },
      { Metric: "routePositive", Value: summary.routePositive },
      { Metric: "executableNow", Value: summary.executableNow },
      { Metric: "Best net edge", Value: formatMoney(summary.bestNetEdgeUsd) },
      { Metric: "Max accepted-vs-acquisition bps", Value: formatBps(summary.maxAcceptedVsAcquisitionBps) },
      { Metric: "Min break-even gap bps", Value: formatBps(summary.minBreakEvenGapBps) },
    ], ["Metric", "Value"]),
    "",
    "## Fail-closed route-gate requirement",
    "",
    "This scanner is intentionally non-exploitative and fail-closed. All rows are non-route-positive until all required gates are present locally:\n",
    "- local public/executable PT market quote reference",
    "- positive executable acquisition/exit quote path",
    "- signed-action/fork provenance",
    "- and exact positive economics after fees/slippage/gas.",
    "",
    `- artifactOnly: true` ,
    `- sourceOnly: true`,
    `- routePositive: false`,
    `- executableNow: false`,
    `- signedActionJustified: false`,
    `- signedActions: false`,
    `- rpcInventoryRead: false`,
    "",
    "## Source artifacts",
    `- ${sourceRel(FILES.ptUnitMismatch)}`,
    `- ${sourceRel(FILES.siloRoutes)}`,
    `- ${sourceRel(FILES.pendleConsumerGraph)}`,
    `- ${sourceRel(FILES.falconProbe)}`,
    "",
    "## Source semantic facts used",
    ...SOURCE_FACTS.map((fact, index) => {
      const fileRef = `- (${index + 1}) ${fact.id}\n  - file: ${fact.file}:${fact.lines}\n  - statement: ${fact.statement}\n  - snippet: ${fact.snippet}`;
      return fileRef;
    }),
    "",
    "## Top blocked candidates",
    markdownTable(topRowsForMd, [
      "Rank",
      "Source",
      "Protocol",
      "Chain",
      "PT",
      "Loan",
      "Semantic",
      "Unit proof",
      "Economics",
      "Accepted bps",
      "Gap bps",
      "Net edge",
      "Top blocker",
    ]),
    "",
    "## Source linkage notes",
    `- Silo-route enrichment matches: ${topRows.filter((row) => row.sourceLinks?.linksToSiloRoute).length}`,
    `- Pendle consumer graph enrichment matches: ${topRows.filter((row) => row.sourceLinks?.linksToPendleConsumerMatch).length}`,
    `- Falcon probe ambiguity matches: ${topRows.filter((row) => row.sourceLinks?.linksToFalconProbe).length}`,
    "",
  ].join("\n");

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-pt-oracle-semantic-gaps.js",
    scope: "Artifact-only PT oracle semantic-gap enrichment using local pt-oracle mismatch and PT route artifacts",
    safety: {
      artifactOnly: true,
      sourceOnly: true,
      rpcInventoryRead: false,
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
      ptUnitMismatch: sourceRel(FILES.ptUnitMismatch),
      siloPtOracleRoutes: sourceRel(FILES.siloRoutes),
      pendlePtConsumerGraph: sourceRel(FILES.pendleConsumerGraph),
      falconPtOracleProbe: sourceRel(FILES.falconProbe),
    },
    sourceFacts: SOURCE_FACTS.map((fact) => ({
      ...fact,
      snippet: fact.snippet,
    })),
    summary,
    topRows,
    rows: topRows,
    routePositiveRows: [],
    requiredForRoutePositive: [
      "PT market price/acquisition must be represented with a public or executable reference.",
      "Oracle economics must clear required premium + break-even constraints with exact quote execution path.",
      "No config-decode ambiguity or source-implementation mismatch should remain unaddressed.",
      "Signed-action/fork/exploit provenance must be explicit in local artifacts.",
    ],
  };

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(output, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, md);

  if (!QUIET) {
    console.log(`PT semantic gap rows: ${summary.rows}`);
    console.log(`Fallback source rows: ${summary.sourceRowsUsed.unitTopRows > 0 ? "topRows" : "routePositiveRows"}`);
    console.log(`Output JSON: ${sourceRel(OUT_JSON)}`);
    console.log(`Output triage: ${sourceRel(OUT_MD)}`);
  }
}

main();
