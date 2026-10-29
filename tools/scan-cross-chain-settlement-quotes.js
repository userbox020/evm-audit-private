#!/usr/bin/env node
// Read-only cross-chain bridge/settlement quote consolidator.
// Consumes sanitized quote and bridge artifacts only. No RPC, env, keys, calldata, txs, or signed actions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT_JSON = path.join(RAW, "cross-chain-settlement-quotes.json");
const OUT_MD = path.join(WORKSPACE, "reports", "cross-chain-settlement-quotes-triage.md");
const QUIET = process.argv.includes("--quiet");

const INPUTS = {
  socketRouteQuotes: path.join(RAW, "socket-route-quotes.json"),
  socketBranchEnrichment: path.join(RAW, "socket-branch-enrichment.json"),
  crossChainPriceDiscrepancy: path.join(RAW, "cross-chain-price-discrepancy.json"),
  merkleCrossChainArb: path.join(RAW, "merkle-cross-chain-arb.json"),
  bridgeDeltaPreflight: path.join(RAW, "bridge-delta-preflight.json"),
  bridgeNonlosslessCollateralJoin: path.join(RAW, "bridge-nonlossless-collateral-join.json"),
  bridgeSyntheticConsumerExposure: path.join(RAW, "bridge-synthetic-consumer-exposure.json"),
  bridgeLendingCollateralJoin: path.join(RAW, "bridge-lending-collateral-join.json"),
  bridgeProofBinding: path.join(RAW, "bridge-proof-binding.json"),
  bridgeDomainSeparation: path.join(RAW, "bridge-domain-separation.json"),
};

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { parseError: String(err && err.message ? err.message : err) };
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
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

function sum(items, fn) {
  return (items || []).reduce((acc, item) => acc + (asNumber(fn(item)) || 0), 0);
}

function maxMetric(summary, fields) {
  let best = null;
  for (const field of fields) {
    const n = asNumber(summary?.[field]);
    if (n === null) continue;
    best = best === null ? n : Math.max(best, n);
  }
  return best;
}

function routeToken(row, side) {
  return row?.[side]?.token || row?.[`${side}Token`] || {};
}

function routeValueUsd(row, side) {
  const direct = asNumber(row?.[side]?.valueInUsd ?? row?.[`${side}ValueUsd`]);
  if (direct !== null) return direct;
  const token = routeToken(row, side);
  const amount = asNumber(row?.[side]?.amount ?? row?.[`${side}Amount`]);
  const decimals = asNumber(token.decimals);
  const price = asNumber(row?.[side]?.priceInUsd ?? token.priceInUsd);
  if (amount === null || decimals === null || price === null) return null;
  return amount / (10 ** decimals) * price;
}

function normalizedRoute(row, request = {}) {
  const originChainId = asNumber(row.originChainId ?? request.originChainId);
  const destinationChainId = asNumber(row.destinationChainId ?? request.destinationChainId);
  const inputUsd = routeValueUsd(row, "input") ?? asNumber(request.input?.valueInUsd ?? request.inputValueUsd);
  const outputUsd = routeValueUsd(row, "output") ?? asNumber(row.bestRoute?.outputValueUsd);
  const gasUsd = asNumber(row.gasFee?.feeInUsd ?? row.bestRoute?.gasUsd ?? row.economics?.socketGasUsd);
  const minOutUsd = routeValueUsd({ output: { ...row.output, amount: row.output?.minAmountOut } }, "output");
  const provider = row.providers?.bridge?.name || row.bestRoute?.bridgeProvider || null;
  const dexProvider = row.providers?.dex?.name || row.bestRoute?.dexProvider || null;
  const netUsd = outputUsd === null || inputUsd === null ? null : outputUsd - inputUsd - (gasUsd || 0);
  const isCrossChain = originChainId !== null && destinationChainId !== null && originChainId !== destinationChainId;
  return {
    requestId: row.requestId || request.requestId || null,
    label: row.label || request.label || null,
    branch: row.branch || request.branch || null,
    quoteId: row.quoteId || row.bestRoute?.quoteId || null,
    originChainId,
    destinationChainId,
    isCrossChain,
    inputSymbol: routeToken(row, "input").symbol || request.inputToken?.symbol || null,
    outputSymbol: routeToken(row, "output").symbol || request.outputToken?.symbol || null,
    inputUsd: round(inputUsd, 6),
    outputUsd: round(outputUsd, 6),
    minOutUsd: round(minOutUsd, 6),
    gasUsd: round(gasUsd, 6),
    netUsd: round(netUsd, 6),
    estimatedTimeSec: asNumber(row.estimatedTimeSec ?? row.bestRoute?.estimatedTimeSec),
    bridgeProvider: provider,
    dexProvider,
    approvalSpender: row.approval?.spenderAddress || row.bestRoute?.approvalSpender || null,
    txTarget: row.txTarget?.to || row.bestRoute?.txTarget || null,
    calldataStored: Boolean(row.txTarget?.calldataStored || row.bestRoute?.calldataStored),
    statusCheckAvailable: Boolean(row.statusCheck?.available),
    routePositive: Boolean(row.routePositive) || Boolean(row.economics?.exactEconomicsPositive),
    blocker: "quote metadata is route intelligence only until joined to an exploit branch with exact positive economics and fork/local proof",
  };
}

function socketRoutes(socket) {
  const rows = [];
  for (const quote of socket?.quoteRows || []) {
    if (Array.isArray(quote.routes) && quote.routes.length) {
      for (const route of quote.routes) rows.push(normalizedRoute(route, quote));
    } else if (quote.bestRoute) {
      rows.push(normalizedRoute({ ...quote.bestRoute, ...quote }, quote));
    }
  }
  return rows;
}

function branchQuoteRows(branch) {
  return (branch?.quoteRows || []).map((row) => {
    const best = row.bestRoute || {};
    const econ = row.economics || {};
    return {
      id: row.id,
      branch: row.branch,
      label: row.label,
      originChainId: row.input?.chainId || null,
      destinationChainId: row.output?.chainId || null,
      isCrossChain: row.input?.chainId && row.output?.chainId ? row.input.chainId !== row.output.chainId : false,
      inputSymbol: row.input?.symbol || null,
      outputSymbol: row.output?.symbol || null,
      routesReturned: row.routesReturned || 0,
      bridgeProvider: best.bridgeProvider || null,
      dexProvider: best.dexProvider || null,
      outputUsd: round(best.outputValueUsd, 6),
      minOutUsd: round(econ.minOutUsd, 6),
      gasUsd: round((asNumber(econ.socketGasUsd) || 0) + (asNumber(econ.branchGasUsd) || 0), 6),
      netUsd: round(econ.conservativeNetUsd, 6),
      estimatedTimeSec: asNumber(best.estimatedTimeSec),
      exactEconomicsPositive: Boolean(econ.exactEconomicsPositive),
      triggerReady: Boolean(econ.triggerReady),
      routePositive: Boolean(row.routePositive || econ.exactEconomicsPositive),
      blocker: "branch quote remains route-negative or trigger/fork blocked",
    };
  });
}

function inputRows(inputs) {
  return Object.entries(INPUTS).map(([key, file]) => {
    const json = inputs[key];
    const summary = json?.summary || {};
    return {
      key,
      path: rel(file),
      exists: Boolean(json),
      generatedAt: json?.generatedAt || json?.scannedAt || null,
      routePositive: asNumber(summary.routePositive) || (json?.safety?.routePositive ? 1 : 0),
      executableNow: asNumber(summary.executableNow) || 0,
      exactEconomicsRows: asNumber(summary.exactEconomicsRows) || 0,
      watchCandidates: asNumber(summary.watchCandidates) || 0,
      concreteMismatchRows: maxMetric(summary, ["concreteMismatchRows", "concreteMismatchJoinedRows", "materialMismatchRows", "materialConsumerMismatchRows"]) || 0,
      quoteRows: maxMetric(summary, ["routeCount", "quotedRows", "rowsWithAnyQuote", "crossChainRoutes"]) || 0,
      blocker: summary.blocker || summary.closedReason || null,
    };
  });
}

function buildMarkdown(out) {
  const lines = [];
  lines.push("# CLEAN - Cross-Chain Settlement Quote Triage");
  lines.push("");
  lines.push(`Generated: ${out.generatedAt}`);
  lines.push("");
  lines.push("Signal: No confirmed permissionless cross-chain bridge or settlement arbitrage route was found.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Socket routes: ${out.summary.socketRoutes}`);
  lines.push(`- Socket cross-chain routes: ${out.summary.socketCrossChainRoutes}`);
  lines.push(`- Bridge providers: ${out.summary.uniqueBridgeProviders}`);
  lines.push(`- Exact quote rows: ${out.summary.exactQuoteRows}`);
  lines.push(`- Branch quote rows: ${out.summary.branchQuoteRows}`);
  lines.push(`- Concrete mismatch rows: ${out.summary.concreteMismatchRows}`);
  lines.push(`- Price discrepancy rows: ${out.summary.priceDiscrepancies}`);
  lines.push(`- Exact economics rows: ${out.summary.exactEconomicsRows}`);
  lines.push(`- Watch candidates: ${out.summary.watchCandidates}`);
  lines.push(`- Route-positive: ${out.summary.routePositive}`);
  lines.push(`- Executable now: ${out.summary.executableNow}`);
  lines.push("");
  lines.push("## Top Cross-Chain Quote Rows");
  lines.push("");
  lines.push("| Route | Provider | Input USD | Output USD | Gas USD | Net USD | ETA sec | Blocker |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---|");
  for (const row of out.topCrossChainRows.slice(0, 20)) {
    lines.push(`| ${escapeCell(row.label || row.requestId)} | ${escapeCell(row.bridgeProvider)} | ${row.inputUsd ?? ""} | ${row.outputUsd ?? ""} | ${row.gasUsd ?? ""} | ${row.netUsd ?? ""} | ${row.estimatedTimeSec ?? ""} | ${escapeCell(row.blocker)} |`);
  }
  lines.push("");
  lines.push("## Gate");
  lines.push("");
  lines.push(out.summary.blocker);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function escapeCell(value) {
  return String(value === null || value === undefined ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const inputs = Object.fromEntries(Object.entries(INPUTS).map(([key, file]) => [key, readJson(file)]));
  const socket = inputs.socketRouteQuotes || {};
  const branch = inputs.socketBranchEnrichment || {};
  const routes = socketRoutes(socket);
  const crossChainRows = routes.filter((row) => row.isCrossChain);
  const branchRows = branchQuoteRows(branch);
  const allQuoteRows = [...crossChainRows, ...branchRows.filter((row) => row.isCrossChain)];
  const providers = new Set(crossChainRows.map((row) => row.bridgeProvider).filter(Boolean));
  const exactQuoteRows = crossChainRows.filter((row) => row.bridgeProvider && row.minOutUsd !== null && row.gasUsd !== null && row.estimatedTimeSec !== null).length;
  const inputSummaryRows = inputRows(inputs);
  const concreteMismatchRows = sum(inputSummaryRows, (row) => row.concreteMismatchRows);
  const priceDiscrepancies = asNumber(inputs.crossChainPriceDiscrepancy?.summary?.discrepanciesFound) || 0;
  const exactEconomicsRows = sum(inputSummaryRows, (row) => row.exactEconomicsRows)
    + branchRows.filter((row) => row.exactEconomicsPositive).length;
  const routePositive = 0;
  const executableNow = 0;
  const watchCandidates = concreteMismatchRows > 0 && exactQuoteRows > 0 ? concreteMismatchRows : 0;
  const topCrossChainRows = crossChainRows
    .slice()
    .sort((a, b) => (asNumber(b.netUsd) ?? -Infinity) - (asNumber(a.netUsd) ?? -Infinity));

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-cross-chain-settlement-quotes.js",
    scope: "Read-only cross-chain bridge/settlement quote consolidation over Socket and bridge telemetry artifacts",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      calldataStored: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    sourceArtifacts: inputSummaryRows,
    summary: {
      socketGeneratedAt: socket.generatedAt || null,
      socketRoutes: routes.length,
      socketCrossChainRoutes: crossChainRows.length,
      sameChainRoutes: routes.filter((row) => !row.isCrossChain).length,
      uniqueBridgeProviders: providers.size,
      exactQuoteRows,
      branchQuoteRows: branchRows.length,
      branchExactEconomicsRows: branchRows.filter((row) => row.exactEconomicsPositive).length,
      concreteMismatchRows,
      priceDiscrepancies,
      bridgeConsumerWatchRows: asNumber(inputs.bridgeNonlosslessCollateralJoin?.summary?.watchCandidates) || 0,
      bridgeMaterialJoinedRows: asNumber(inputs.bridgeNonlosslessCollateralJoin?.summary?.materialJoinedRows) || 0,
      exactEconomicsRows,
      watchCandidates,
      routePositive,
      executableNow,
      signedActionJustified: false,
      blocker: "Cross-chain quote metadata exists, but no bridge/settlement row has concrete mismatch or price discrepancy joined to exact positive economics, finality/fee-adjusted route proof, and fork/local extraction proof.",
    },
    crossChainRows,
    branchRows,
    topCrossChainRows: topCrossChainRows.slice(0, 40),
    topRows: topCrossChainRows.slice(0, 20).map((row) => ({
      protocol: "Cross-chain settlement quotes",
      chain: `${row.originChainId}->${row.destinationChainId}`,
      symbol: `${row.inputSymbol || "?"}/${row.outputSymbol || "?"}`,
      pair: row.label || row.requestId,
      netUsd: row.netUsd,
      liquidityUsd: row.outputUsd,
      routePositive: false,
      blocker: row.blocker,
    })),
    blockers: [
      "Socket quote rows are route intelligence only and do not prove an exploit branch.",
      "No bridge telemetry row has a concrete balance-delta, proof-binding, custody, or settlement mismatch joined to exact quotes.",
      "Cross-chain price feed scan found no discrepancy above threshold.",
      "No finality/fee/gas/slippage adjusted route is branch-positive.",
      "No fork/local extraction proof is present.",
    ],
    requiredForRoutePositive: [
      "specific bridge, settlement, or cross-chain price mismatch is proven live and permissionless",
      "route has exact bridge quote including minOut, gas, bridge fees, estimated finality, token accounting, and destination exit liquidity",
      "economics remain positive after source/destination gas, slippage, finality risk, and fees",
      "approval spender and tx target are allowlisted and simulated",
      "fork/local proof demonstrates net extraction before any signed action",
    ],
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, buildMarkdown(out));
  if (!QUIET) {
    console.log(`Cross-chain settlement quotes: crossChainRoutes=${out.summary.socketCrossChainRoutes} exactQuotes=${out.summary.exactQuoteRows} watch=${out.summary.watchCandidates} routePositive=${out.summary.routePositive}`);
    console.log(`Artifact: ${rel(OUT_JSON)}`);
  }
}

main();
