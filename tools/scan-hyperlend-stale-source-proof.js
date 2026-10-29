#!/usr/bin/env node
// Artifact-only HyperLend stale-source proof harness.
// Reads local artifacts and local source snippets only; no RPC/exploit calls.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  staleSourceRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlend-stale-source-routes.json"),
  hyperlendLive: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlend-live.json"),
  routePositiveSweep: path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json"),
  aaveOracle: path.join(WORKSPACE, "targets", "hyperlend-core", "src", "contracts", "misc", "AaveOracle.sol"),
  aggregatorInterface: path.join(WORKSPACE, "targets", "hyperlend-core", "src", "contracts", "dependencies", "chainlink", "AggregatorInterface.sol"),
  dualFallbackOracle: path.join(WORKSPACE, "targets", "hyperevm-oracle", "contracts", "adapters", "DualFallbackOracle.sol"),
  pythOracleAdapter: path.join(WORKSPACE, "targets", "hyperevm-oracle", "contracts", "adapters", "PythOracleAdapter.sol"),
  assetOracleAdapter: path.join(WORKSPACE, "targets", "hyperevm-oracle", "contracts", "adapters", "AssetOracleAdapter.sol"),
};

const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "hyperlend-stale-source-proof.json");
const OUT_MD = path.join(WORKSPACE, "reports", "hyperlend-stale-source-proof-triage.md");

const MIN_STALE_SECONDS = 3600;
const MIN_ROUTE_LIQUIDITY_USD = 10_000;
const COST_BUFFER_PCT = 0;

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return null;
  }
}

function readJson(filePath, fallback = null) {
  const text = readText(filePath);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
}

function linesForMatch(filePath, match) {
  const text = readText(filePath);
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((line) => line.includes(match));
  if (idx < 0) return null;
  const start = Math.max(0, idx - 1);
  const end = Math.min(lines.length - 1, idx + 5);
  return {
    lines: `${start + 1}-${end + 1}`,
    snippet: lines.slice(start, end + 1).join("\n"),
  };
}

function extractFunctionSnippet(fileText, functionName) {
  const lines = fileText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(`function ${functionName}`));
  if (start < 0) return null;

  let depth = 0;
  let foundOpen = false;
  let end = start;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("{") && !foundOpen) {
      foundOpen = true;
    }
    if (foundOpen) {
      depth += (line.match(/\{/g) || []).length;
      depth -= (line.match(/\}/g) || []).length;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (!foundOpen) return null;
  return {
    startLine: start + 1,
    endLine: end + 1,
    snippet: lines.slice(start, end + 1).join("\n"),
    body: lines.slice(start, end + 1).join("\n"),
  };
}

function loadHyperlendSourceFacts() {
  const facts = [];
  const proof = {
    aaveNoFreshnessGuard: false,
    dualFallbackHeartbeat: false,
    pythTimestampRead: false,
    assetLatestRoundData: false,
    chainlinkInterfacePresent: false,
  };

  const aaveText = readText(FILES.aaveOracle);
  if (aaveText) {
    const fn = extractFunctionSnippet(aaveText, "getAssetPrice");
    if (fn) {
      const body = fn.body || "";
      const hasLatestAnswer = /latestAnswer\(\)/.test(body);
      const hasLatestTimestamp = /latestTimestamp/.test(body);
      const hasLatestRoundData = /latestRoundData/.test(body);
      const hasFallback = /_fallbackOracle\.getAssetPrice\(asset\)/.test(body);
      proof.aaveNoFreshnessGuard = hasLatestAnswer && !hasLatestTimestamp && !hasLatestRoundData && hasFallback;
      facts.push({
        id: "aaveOracle.getAssetPrice-stale-input-unchecked",
        file: rel(FILES.aaveOracle),
        lines: `${fn.startLine}-${fn.endLine}`,
        statement:
          "AaveOracle.getAssetPrice() uses source.latestAnswer() and only switches to fallback on non-positive answer, with no updatedAt/latestRoundData freshness gating. This is the stale-vs-live acceptance condition under review.",
        snippet: fn.snippet,
      });
    }
  }

  const aggText = readText(FILES.aggregatorInterface);
  if (
    aggText &&
    /latestAnswer/.test(aggText) &&
    /latestTimestamp/.test(aggText) &&
    /latestRound/.test(aggText) &&
    /getAnswer/.test(aggText) &&
    /getTimestamp/.test(aggText)
  ) {
    proof.chainlinkInterfacePresent = true;
    const lines = aggText.split(/\r?\n/);
    const match = lines.findIndex((line) => line.includes("function latestAnswer"));
    const start = Math.max(0, match - 1);
    const end = Math.min(lines.length - 1, match + 12);
    facts.push({
      id: "chainlinkLike.AggregatorInterface.timestamp-and-round-apis-exist",
      file: rel(FILES.aggregatorInterface),
      lines: `${start + 1}-${end + 1}`,
      statement:
        "Chainlink-like interface exposes latestAnswer, latestTimestamp, latestRound, getAnswer(), and getTimestamp(); stale-input freshness is enforced at the AaveOracle consumer, not in this interface.",
      snippet: lines.slice(start, end + 1).join("\n"),
    });
  }

  const dualText = readText(FILES.dualFallbackOracle);
  if (dualText) {
    const getData = extractFunctionSnippet(dualText, "getData");
    const isPrimaryHealthy = extractFunctionSnippet(dualText, "_isPrimaryHealthy");
    const isFallbackHealthy = extractFunctionSnippet(dualText, "_isFallbackHealthy");
    if (getData && isPrimaryHealthy && isFallbackHealthy) {
      const body = `${getData.body}\n${isPrimaryHealthy.body}\n${isFallbackHealthy.body}`;
      proof.dualFallbackHeartbeat = /MAX_HEARTBEAT_INTERVAL_PRIMARY/.test(body) && /MAX_HEARTBEAT_INTERVAL_FALLBACK/.test(body) && /_isPrimaryHealthy/.test(body);
      facts.push({
        id: "dualFallbackOracle.heartbeat-controlled-answer-path",
        file: rel(FILES.dualFallbackOracle),
        lines: `${getData.startLine}-${isFallbackHealthy.endLine}`,
        statement:
          "DualFallbackOracle.getData() switches primary/fallback when health checks fail; _isPrimaryHealthy / _isFallbackHealthy enforce MAX_HEARTBEAT_INTERVAL_* on updatedAt and positive-price checks.",
        snippet: `${getData.snippet}\n\n${isPrimaryHealthy.snippet}\n\n${isFallbackHealthy.snippet}`,
      });
    }
  }

  const pythText = readText(FILES.pythOracleAdapter);
  if (pythText) {
    const latestAnswer = extractFunctionSnippet(pythText, "latestAnswer");
    const latestTimestamp = extractFunctionSnippet(pythText, "latestTimestamp");
    if (latestAnswer && latestTimestamp) {
      const hasPublishTime = /publishTime/.test(latestTimestamp.body) && /publishTime/.test(latestAnswer.body);
      proof.pythTimestampRead = hasPublishTime;
      const lines = pythText.split(/\r?\n/);
      const tsMatch = lines.findIndex((line) => line.includes("function latestTimestamp"));
      const start = Math.max(0, tsMatch - 1);
      const end = Math.min(lines.length - 1, tsMatch + 14);
      facts.push({
        id: "pythOracleAdapter.timestamp-read",
        file: rel(FILES.pythOracleAdapter),
        lines: `${start + 1}-${end + 1}`,
        statement:
          "PythOracleAdapter.latestTimestamp() returns publishTime from pyth.getPriceUnsafe(feed), and latestAnswer() also reads same feed field, indicating timestamp availability when present.",
        snippet: lines.slice(start, end + 1).join("\n"),
      });
    }
  }

  const assetText = readText(FILES.assetOracleAdapter);
  if (assetText) {
    const latestRoundData = extractFunctionSnippet(assetText, "latestRoundData");
    const latestAnswer = extractFunctionSnippet(assetText, "latestAnswer");
    if (latestRoundData && latestAnswer) {
      proof.assetLatestRoundData = /latestRoundData/.test(latestRoundData.body);
      const lines = assetText.split(/\r?\n/);
      const roundMatch = lines.findIndex((line) => line.includes("function latestRoundData"));
      const start = Math.max(0, roundMatch - 1);
      const end = Math.min(lines.length - 1, roundMatch + 12);
      facts.push({
        id: "assetOracleAdapter.round-data-path",
        file: rel(FILES.assetOracleAdapter),
        lines: `${start + 1}-${end + 1}`,
        statement:
          "AssetOracleAdapter.latestAnswer() reads aggregator.getPrice(asset); latestRoundData() also surfaces block timestamps from getUpdateTimestamp fallback-read semantics.",
        snippet: lines.slice(start, end + 1).join("\n"),
      });
    }
  }

  return { facts, proof };
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function deriveDirection(row) {
  if (row?.route?.direction) return row.route.direction;
  const divergence = asNumber(row?.oracleVsRefPct);
  const ltv = asNumber(row?.ltv);
  const borrowingEnabled = Boolean(row?.borrowingEnabled);
  const cashUsd = asNumber(row?.cashUsd);

  if (divergence === null) return "blocked";
  if (divergence > 0 && ltv > 0) return "overvalued-collateral";
  if (divergence < 0 && borrowingEnabled && cashUsd !== null && cashUsd > 0) return "underpriced-borrow";
  return "blocked";
}

function routeCollateralLtv(row, allRows) {
  const route = row?.route;
  const collateralAsset = String(route?.collateralAsset || row?.asset || "").toLowerCase();
  const match = allRows.find((candidate) => String(candidate?.asset || "").toLowerCase() === collateralAsset);
  return asNumber(match?.ltv ?? row?.ltv);
}

function rowHasExactQuote(row) {
  return Boolean(
    row?.exactQuote ||
    row?.exactRouteQuote ||
    row?.exactBorrowQuote ||
    row?.exactExitQuote ||
    row?.exactEconomics ||
    row?.forkProof
  );
}

function rowHasBorrowerLiquidationProof(row) {
  return Boolean(
    row?.borrowerLiquidationProof ||
    row?.liquidationProof ||
    row?.staleAdjustedHealthFactorProof ||
    row?.forkLiquidationProof
  );
}

function pickOvervaluedRouteLiquidity(row, allRows, minRouteLiquidity) {
  const route = row?.route;
  if (route && asNumber(route.routeLiquidityUsd) !== null) return asNumber(route.routeLiquidityUsd);

  const stable = allRows
    .filter((candidate) => candidate.kind === "stable")
    .filter((candidate) => asNumber(candidate.cashUsd) !== null)
    .filter((candidate) => asNumber(candidate.cashUsd) >= minRouteLiquidity)
    .filter((candidate) => candidate.ltv !== undefined && asNumber(candidate.ltv) > 0)
    .sort((a, b) => (asNumber(b.cashUsd) || 0) - (asNumber(a.cashUsd) || 0));

  return stable.length ? asNumber(stable[0].cashUsd) : null;
}

function parseRoutePositiveSweepHint(sweepJson) {
  if (!sweepJson || !Array.isArray(sweepJson.rows)) return null;
  const row = sweepJson.rows.find((entry) => entry?.id === "hyperlend-stale-source-sweep") || null;
  if (!row) return null;

  return {
    routePositive: asNumber(row.routePositive) || 0,
    executableNow: Boolean(row.executableNow),
    signedActionJustified: Boolean(row.signedActionJustified),
    topRows: Array.isArray(row.topRows) ? row.topRows : null,
    blockers: Array.isArray(row.blockers) ? row.blockers : null,
    status: row.status || null,
  };
}

function formatMoney(v) {
  const n = asNumber(v);
  if (n === null) return null;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function rowTable(rows, keys) {
  const header = `| ${keys.join(" | ")} |`;
  const sep = `| ${keys.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) =>
    `| ${keys.map((k) => {
      const value = row[k];
      return String(value === null || value === undefined ? "" : value).replace(/\|/g, "");
    }).join(" | ")} |`
  );
  return [header, sep, ...body].join("\n");
}

function markdownReport(out) {
  const sum = out.summary || {};
  const sourceFacts = out.sourceFacts || [];
  const topRows = out.topRows || [];

  const summaryBlock = {
    "Rows input": out.rows?.length || 0,
    "Stale accepted": sum.staleAcceptedRows || 0,
    "Material divergence": sum.materialDivergenceRows || 0,
    "Watch candidates": sum.watchCandidates || 0,
    "routePositive": sum.routePositive || 0,
    "Executable now": sum.executableNow || 0,
    "Signed-action justified": Boolean(sum.signedActionJustified),
    "Atomic break-even rows": sum.atomicBreakEvenRows || 0,
    "Liquidation proof rows": sum.liquidationProofRows || 0,
    "Exact quote rows": sum.exactQuoteRows || 0,
    "Atomic break-even calculated rows": sum.atomicBreakEvenCalculatedRows || 0,
  };

  const blockRows = [
    `- artifact-only: ${out.sourceArtifacts ? "hyperlend stale-source artifacts + local source files only" : "n/a"}`,
    `- scanner: ${out.scanner}`,
    `- generatedAt: ${out.generatedAt}`,
    `- safety routePositive: ${out.safety?.routePositive ? "open" : "closed"}`,
    `- safety executableNow: ${out.safety?.executableNow ? "open" : "closed"}`,
    `- safety signedActionJustified: ${out.safety?.signedActionJustified ? "true" : "false"}`,
  ];

  const mdTopRows = topRows
    .slice(0, 8)
    .map((row) => ({
      Rank: row.rank,
      Asset: row.symbol,
      SourceType: row.sourceType,
      Divergence: row.divergencePct !== null ? `${row.divergencePct}%` : "",
      Route: row.route,
      RouteLiquidityUsd: formatMoney(row.routeLiquidityUsd),
      GrossEdgeUsd: formatMoney(row.grossEdgeUsd),
      AtomicBreakEvenPct: row.atomicBreakEvenDivergencePct,
      Status: row.status,
      Blockers: (row.blockers || [""])[0],
    }));

  const factMd = sourceFacts
    .map(
      (fact) =>
        `- (${fact.id}) ${fact.file}:${fact.lines}\n  - ${fact.statement}\n  - snippet: ${fact.snippet?.replace(/\n/g, " ")}`
    )
    .join("\n");

  return [
    "# 🟢 DORMANT — HyperLend Stale-Source Proof Harness",
    "",
    `Date: ${out.generatedAt ? out.generatedAt.slice(0, 10) : "unknown"}`,
    "",
    "## Scope",
    `- Scope: ${out.scope}`,
    `- Source artifacts: ${Array.isArray(out.sourceArtifacts) ? out.sourceArtifacts.join(", ") : Object.values(out.sourceArtifacts || {}).join(", ")}`,
    "",
    "## Verdict",
    `No route-positive result is open. Summary: routePositive=${sum.routePositive || 0}, executableNow=${sum.executableNow || 0}, signedActionJustified=${Boolean(sum.signedActionJustified)}`,
    sum.blockers ? `- Blockers: ${sum.blockers.join(", ")}` : "- Blockers: none",
    "",
    "## Gate summary",
    Object.entries(summaryBlock)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n"),
    "",
    "## Status map",
    rowTable(mdTopRows, [
      "Rank",
      "Asset",
      "SourceType",
      "Divergence",
      "Route",
      "RouteLiquidityUsd",
      "GrossEdgeUsd",
      "AtomicBreakEvenPct",
      "Status",
      "Blockers",
    ]),
    "",
    "## Source facts used",
    factMd || "- No source snippets loaded.",
    "",
    "## Safety gates",
    `- routePositive requires: ${out.gates?.routePositiveRequires ? out.gates.routePositiveRequires.join(", ") : "n/a"}`,
    `- signedAction requires: ${out.gates?.signedActionRequires ? out.gates.signedActionRequires.join(", ") : "n/a"}`,
    `- minStaleSeconds=${out.gates?.minStaleSeconds || MIN_STALE_SECONDS}, minRouteLiquidityUsd=${out.gates?.minRouteLiquidityUsd || MIN_ROUTE_LIQUIDITY_USD}, costBufferPct=${out.gates?.costBufferPct || COST_BUFFER_PCT}`,
    "",
    "## Read-only command",
    "`node --check tools\\scan-hyperlend-stale-source-proof.js`",
    "`node tools/scan-hyperlend-stale-source-proof.js --quiet`",
  ].join("\n");
}

function main() {
  const staleRoutes = readJson(FILES.staleSourceRoutes, null);
  const routePositiveSweep = readJson(FILES.routePositiveSweep, null);
  const live = readJson(FILES.hyperlendLive, null);

  const { facts: sourceFacts, proof: proofFlags } = loadHyperlendSourceFacts();
  const hasRoutesFile = Boolean(staleRoutes && Array.isArray(staleRoutes.watchRows));
  const liveRows = Array.isArray(live?.coreReserves) ? live.coreReserves : [];

  const sweepHint = parseRoutePositiveSweepHint(routePositiveSweep);
  const minStaleSeconds = asNumber(staleRoutes?.gates?.minStaleSeconds) || MIN_STALE_SECONDS;
  const minRouteLiquidityUsd = asNumber(staleRoutes?.gates?.minRouteLiquidityUsd) || MIN_ROUTE_LIQUIDITY_USD;

  const sourceArtifacts = {
    hyperlendStaleSourceRoutes: rel(FILES.staleSourceRoutes),
    routePositiveSweep: fs.existsSync(FILES.routePositiveSweep) ? rel(FILES.routePositiveSweep) : null,
    hyperlendLive: fs.existsSync(FILES.hyperlendLive) ? rel(FILES.hyperlendLive) : null,
    aaveOracle: rel(FILES.aaveOracle),
    aggregatorInterface: rel(FILES.aggregatorInterface),
    dualFallbackOracle: rel(FILES.dualFallbackOracle),
    pythOracleAdapter: rel(FILES.pythOracleAdapter),
    assetOracleAdapter: rel(FILES.assetOracleAdapter),
  };

  const summary = {
    rowsInput: hasRoutesFile ? staleRoutes.watchRows.length : 0,
    staleAcceptedRows: 0,
    materialDivergenceRows: 0,
    watchCandidates: 0,
    atomicBreakEvenRows: 0,
    atomicBreakEvenCalculatedRows: 0,
    liquidationProofRows: 0,
    exactQuoteRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    status: "route-positive-zero",
    blockers: [],
    topRows: [],
  };

  if (!hasRoutesFile) {
    summary.status = "missing-artifact";
    summary.blockers.push("missing-artifact: hyperlend stale-source routes artifact unavailable");
  }

  let rows = [];
  if (hasRoutesFile) {
    const sweepTopBySymbol = new Map();
    if (Array.isArray(sweepHint?.topRows)) {
      sweepHint.topRows.forEach((entry, idx) => {
        if (!entry?.symbol) return;
        sweepTopBySymbol.set(normalizeSymbol(entry.symbol), {
          rank: idx + 1,
          symbol: entry.symbol,
          direction: entry.direction,
          divergenceMissingPct: asNumber(entry.divergenceMissingPct),
          grossEdgeUsdHint: asNumber(entry.estimatedGrossEdgeUsd),
          routeLiquidityUsdHint: asNumber(entry.routeLiquidityUsd),
        });
      });
    }

    const rowsInput = staleRoutes.watchRows.map((row, index) => {
      const asset = row?.asset || null;
      const symbol = row?.symbol || row?.rawSymbol || "UNKNOWN";
      const sourceType = row?.oracleSourceType || row?.oracleSourceInfo?.type || "unknown";
      const ageSeconds = asNumber(row?.oracleFeedAgeSeconds);
      const divergencePct = asNumber(row?.oracleVsRefPct);
      const minDivergencePct = asNumber(row?.minDivergencePct);
      const staleAccepted = Boolean(row?.staleAccepted && ageSeconds !== null && ageSeconds >= minStaleSeconds);
      const materialDivergence = divergencePct !== null && minDivergencePct !== null && Math.abs(divergencePct) >= minDivergencePct;
      const routeDirection = deriveDirection(row);
      const hasSourceProof = sourceType === "DualFallbackOracle" ? proofFlags.dualFallbackHeartbeat : proofFlags.aaveNoFreshnessGuard;
      const routeLiquidityUsd = asNumber(row?.route?.routeLiquidityUsd) !== null
        ? asNumber(row.route.routeLiquidityUsd)
        : routeDirection === "overvalued-collateral"
          ? pickOvervaluedRouteLiquidity(row, staleRoutes.watchRows, minRouteLiquidityUsd)
          : asNumber(row?.cashUsd);
      const grossEdgeUsd = routeLiquidityUsd !== null && divergencePct !== null ? round(Math.abs(routeLiquidityUsd * divergencePct) / 100) : null;
      const ltv = routeCollateralLtv(row, staleRoutes.watchRows);
      const collateralLtvDecimal = ltv !== null && ltv > 0 ? ltv / 100 : null;
      const atomicBreakEvenDivergencePct =
        collateralLtvDecimal !== null && collateralLtvDecimal > 0
          ? round((1 / collateralLtvDecimal - 1) * 100 + COST_BUFFER_PCT)
          : null;
      const divergenceMissingPct =
        divergencePct !== null && minDivergencePct !== null ? round(Math.max(0, Math.abs(divergencePct) >= minDivergencePct ? 0 : minDivergencePct - Math.abs(divergencePct))) : null;
      const atomicBreakEvenMissingPct =
        atomicBreakEvenDivergencePct !== null && divergencePct !== null
          ? round(Math.max(0, atomicBreakEvenDivergencePct - Math.abs(divergencePct)))
          : null;
      const exactQuotePresent = rowHasExactQuote(row);
      const borrowerLiquidationProof = rowHasBorrowerLiquidationProof(row);

      const blockers = [];
      let status = "route-positive-zero";

      if (sourceType === "DualFallbackOracle" && !proofFlags.dualFallbackHeartbeat) {
        status = "source-behavior-not-proven";
        blockers.push("source-behavior-not-proven: DualFallbackOracle heartbeat proof not established from local source artifacts");
      }

      if (sourceType !== "DualFallbackOracle" && !proofFlags.aaveNoFreshnessGuard) {
        status = "source-behavior-not-proven";
        blockers.push("source-behavior-not-proven: AaveOracle stale-input proof unavailable or non-standard");
      }

      if (!hasSourceProof && status === "route-positive-zero") {
        status = "source-behavior-not-proven";
      }

      if (sourceType === "DualFallbackOracle") {
        blockers.push("sourceType=DualFallbackOracle enforces heartbeat internally; generic stale-input oracle-gap route does not apply unless heartbeat paths are proven stale)");
      }

      if (ageSeconds === null) {
        status = "not-stale";
        blockers.push(`ageSeconds unavailable on oracleSource for ${symbol}`);
      } else if (!staleAccepted) {
        status = "not-stale";
        blockers.push(`source age ${Math.round(ageSeconds)}s below minStaleSeconds ${minStaleSeconds}`);
      }

      if (divergencePct === null) {
        status = "stale-no-reference-price";
        blockers.push("stale-no-reference-price: live/reference oracle comparison unavailable");
      } else if (Math.abs(divergencePct) < (minDivergencePct || 0)) {
        if (staleAccepted && status === "route-positive-zero") {
          status = "stale-divergence-below-gate";
        }
        blockers.push(`divergence ${round(divergencePct, 4)}% below gate ${minDivergencePct}%`);
      }

      if (routeDirection === "blocked") {
        status = "no-borrower-liquidation-proof";
        blockers.push("no-borrower-liquidation-proof: direction blocked by divergence sign/asset constraints");
      }

      if (routeLiquidityUsd !== null && routeLiquidityUsd < minRouteLiquidityUsd) {
        if (status === "route-positive-zero") {
          status = "no-borrower-liquidation-proof";
        }
        blockers.push(`route liquidity ${round(routeLiquidityUsd, 2)} below minRouteLiquidityUsd ${minRouteLiquidityUsd}`);
      }

      if (materialDivergence && routeLiquidityUsd !== null && routeLiquidityUsd >= minRouteLiquidityUsd && !exactQuotePresent) {
        status = "material-watch-only-no-exact-quote";
      }

      if (materialDivergence && atomicBreakEvenMissingPct !== null && atomicBreakEvenMissingPct > 0) {
        status = "capital-lock-no-atomic-unwind";
        blockers.push(`oracle divergence needs ${round(atomicBreakEvenMissingPct, 4)} additional pct points to clear atomic LTV break-even`);
      }

      if (!exactQuotePresent) {
        blockers.push("no exact executable borrow/exit/unwind quote with gas/slippage/minProfit");
      }

      if (!borrowerLiquidationProof) {
        blockers.push("no borrower-level stale-adjusted HF/liquidation proof");
      }

      blockers.push("no fork/static value-delta proof");

      const sweepAllowsRoutePositive = Number(sweepHint?.routePositive) > 0;
      const routePositive = (status === "route-positive" && sweepAllowsRoutePositive) || false;
      const executableNow = Boolean(sweepHint?.executableNow) && routePositive;
      const signedActionJustified = Boolean(sweepHint?.signedActionJustified) && executableNow;

      const rowRecord = {
        rank: index + 1,
        asset,
        symbol,
        sourceType,
        staleAccepted,
        materialDivergence,
        ageSeconds,
        divergencePct: divergencePct === null ? null : round(divergencePct),
        minDivergencePct,
        divergenceMissingPct,
        route: routeDirection,
        routeLiquidityUsd,
        grossEdgeUsd,
        atomicBreakEvenDivergencePct,
        atomicBreakEvenMissingPct,
        status,
        blockers,
        exactQuotePresent,
        borrowerLiquidationProof,
        routePositive,
        executableNow: Boolean(executableNow),
        signedActionJustified: Boolean(signedActionJustified),
      };

      return rowRecord;
    });

    // Re-rank using sweep top ordering if available, otherwise stale-edge severity.
    const keyed = new Map();
    for (const row of rowsInput) {
      const k = normalizeSymbol(row.symbol);
      keyed.set(k, row);
      if (row.status === "stale-no-reference-price") {
        summary.blockers.push("stale-no-reference-price");
      }
      if (row.status === "source-behavior-not-proven") {
        summary.blockers.push("source-behavior-not-proven");
      }
      if (row.status === "not-stale") {
        summary.blockers.push("not-stale");
      }
      if (row.status === "stale-divergence-below-gate") {
        summary.blockers.push("stale-divergence-below-gate");
      }
      if (row.status === "material-watch-only-no-exact-quote") {
        summary.blockers.push("material-watch-only-no-exact-quote");
      }
      if (row.status === "capital-lock-no-atomic-unwind") {
        summary.blockers.push("capital-lock-no-atomic-unwind");
      }
      if (row.status === "no-borrower-liquidation-proof") {
        summary.blockers.push("no-borrower-liquidation-proof");
      }
      if (!row.exactQuotePresent) summary.blockers.push("no-exact-quote");
      if (!row.borrowerLiquidationProof) summary.blockers.push("no-borrower-liquidation-proof");

      if (row.routePositive) summary.routePositive += 1;
      if (row.executableNow) summary.executableNow += 1;
      if (row.signedActionJustified) summary.signedActionJustified = true;
      if (row.staleAccepted) summary.staleAcceptedRows += 1;
      if (row.divergencePct !== null && row.minDivergencePct !== null && Math.abs(row.divergencePct) >= row.minDivergencePct)
        summary.materialDivergenceRows += 1;
      if (row.atomicBreakEvenDivergencePct !== null) summary.atomicBreakEvenCalculatedRows += 1;
      if (row.atomicBreakEvenDivergencePct !== null && row.divergencePct !== null && Math.abs(row.divergencePct) >= row.atomicBreakEvenDivergencePct)
        summary.atomicBreakEvenRows += 1;
      if (row.exactQuotePresent) summary.exactQuoteRows += 1;
      if (row.borrowerLiquidationProof) summary.liquidationProofRows += 1;

      const isWatchCandidate =
        row.materialDivergence === true &&
        row.staleAccepted === true &&
        asNumber(row.routeLiquidityUsd) >= minRouteLiquidityUsd &&
        !Boolean(row.routePositive);

      if (isWatchCandidate) summary.watchCandidates += 1;
    }

    if (summary.routePositive === 0 && summary.executableNow === 0 && !summary.signedActionJustified) {
      summary.status = "route-positive-zero";
    } else if (summary.signedActionJustified) {
      summary.status = "signed-action-ready";
    }

    const uniqueBlockers = [...new Set(summary.blockers.filter(Boolean))];
    summary.blockers = uniqueBlockers;

    if (!proofFlags.aaveNoFreshnessGuard) {
      summary.status = "source-behavior-not-proven";
    } else if (summary.staleAcceptedRows === 0) {
      summary.status = "not-stale";
    } else if (summary.rowsInput > 0 && summary.routePositive === 0) {
      summary.status = "route-positive-zero";
    }

    const sortedRows = rowsInput.sort((a, b) => {
      const progressA = a.minDivergencePct ? Math.abs(a.divergencePct || 0) / a.minDivergencePct : 0;
      const progressB = b.minDivergencePct ? Math.abs(b.divergencePct || 0) / b.minDivergencePct : 0;
      const scoreA =
        (a.routePositive ? 1_000_000 : 0) +
        (a.materialDivergence ? 100_000 : 0) +
        (a.staleAccepted ? 10_000 : 0) +
        progressA * 1_000 +
        Math.log10(Math.max(1, a.grossEdgeUsd || 0));
      const scoreB =
        (b.routePositive ? 1_000_000 : 0) +
        (b.materialDivergence ? 100_000 : 0) +
        (b.staleAccepted ? 10_000 : 0) +
        progressB * 1_000 +
        Math.log10(Math.max(1, b.grossEdgeUsd || 0));
      return scoreB - scoreA;
    });

    rows = sortedRows.map((row, idx) => ({ ...row, rank: idx + 1 }));

    summary.topRows = rows.slice(0, 5).map((row, idx) => ({
      rank: idx + 1,
      symbol: row.symbol,
      sourceType: row.sourceType,
      route: row.route,
      divergencePct: row.divergencePct,
      divergenceMissingPct: row.divergenceMissingPct,
      routeLiquidityUsd: row.routeLiquidityUsd,
      grossEdgeUsd: row.grossEdgeUsd,
      atomicBreakEvenDivergencePct: row.atomicBreakEvenDivergencePct,
      atomicBreakEvenMissingPct: row.atomicBreakEvenMissingPct,
      status: row.status,
      blockers: row.blockers,
    }));
  }

  if (!hasRoutesFile) {
    rows = [];
    summary.topRows = [];
  }

  const gates = {
    minStaleSeconds,
    minRouteLiquidityUsd,
    costBufferPct: COST_BUFFER_PCT,
    routePositiveRequires: [
      "stale source row",
      "live-vs-reference divergence above per-asset gate",
      "borrow-side (or collateral-side) liquidity above minRouteLiquidityUsd",
      "fresh exact borrow/exit route quote with gas/slippage/minProfit/fork proof",
    ],
    signedActionRequires: [
      "HyperEVM fork extraction proof",
      "deployed executable path with staticCall and gas estimation",
      "explicit signed authorization",
    ],
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-hyperlend-stale-source-proof.js",
    scope: "Artifact-only HyperLend stale-source route proof harness, using local HyperLend stale-source route output and local source files only",
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
    sourceArtifacts,
    sourceFacts,
    gates,
    summary,
    topRows: summary.topRows,
    rows,
  };

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const md = markdownReport(artifact);
  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_MD, md + "\n", "utf8");

  if (!QUIET) {
    console.log("HyperLend stale-source proof artifact generated.");
    console.log(`Rows scored: ${artifact.summary.rowsInput}`);
    console.log(`Stale accepted: ${artifact.summary.staleAcceptedRows}`);
    console.log(`Material divergence: ${artifact.summary.materialDivergenceRows}`);
    console.log(`Watch candidates: ${artifact.summary.watchCandidates}`);
    console.log(`routePositive: ${artifact.summary.routePositive}`);
    console.log(`Executable now: ${artifact.summary.executableNow}`);
    console.log(`Signed action justified: ${artifact.summary.signedActionJustified}`);
    console.log(`JSON: ${rel(OUT_JSON)}`);
    console.log(`Triage: ${rel(OUT_MD)}`);
  }
}

try {
  main();
} catch (error) {
  console.error("scan-hyperlend-stale-source-proof.js failed", error.message);
  if (!QUIET) {
    console.error(error.stack);
  }
  process.exit(1);
}
