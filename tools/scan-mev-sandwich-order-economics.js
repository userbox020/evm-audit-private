#!/usr/bin/env node
// Read-only MEV/sandwich/order-economics consolidator.
// Consumes existing UniswapX transfer/event telemetry and router/RFQ drift artifacts. No RPC, txs, keys, or calldata.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT_JSON = path.join(RAW, "mev-sandwich-order-economics.json");
const OUT_MD = path.join(WORKSPACE, "reports", "mev-sandwich-order-economics-triage.md");
const QUIET = process.argv.includes("--quiet");

const INPUTS = {
  uniswapxMev: path.join(RAW, "uniswapx-filler-mev.json"),
  uniswapxProfit: path.join(RAW, "uniswapx-filler-profit.json"),
  routerRfq: path.join(RAW, "router-rfq-settlement-drift.json"),
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
      forkProofRows: asNumber(summary.forkProofRows) || 0,
      blocker: summary.blocker || summary.closedReason || json?.note || null,
    };
  });
}

function reactorRows(mev) {
  return Object.entries(mev?.byReactor || {}).map(([name, row]) => ({
    reactor: name,
    address: row.address || null,
    totalEvents: asNumber(row.totalEvents) || asNumber(row.events) || 0,
    fillEvents: asNumber(row.fillEvents) || 0,
    uniqueFillers: asNumber(row.uniqueFillers) || 0,
    topFillers: Array.isArray(row.topFillers) ? row.topFillers.slice(0, 10) : [],
    routePositive: false,
    blocker: "fill-event telemetry is not exact economics without decoded order parameters and counterfactual execution price",
  }));
}

function profitRows(profit) {
  return (profit?.results || []).map((row) => {
    const gross = asNumber(row.grossProfit) || 0;
    const net = asNumber(row.netProfit) || 0;
    return {
      txHash: row.txHash,
      filler: row.filler,
      transfers: asNumber(row.transfers) || 0,
      gas: asNumber(row.gas) || 0,
      gasCost: round(row.gasCost, 6),
      valueToFiller: round(row.valueToFiller, 6),
      valueFromFiller: round(row.valueFromFiller, 6),
      grossProfit: round(gross, 6),
      netProfit: round(net, 6),
      marginPct: row.marginPct || null,
      transferOnlyPositive: gross > 0 || net > 0,
      routePositive: false,
      blocker: "transfer-only balance delta is noisy and lacks decoded order input/output, user limit price, auction curve, exact token prices, and fork proof",
    };
  });
}

function buildMarkdown(out) {
  const lines = [];
  lines.push("# CLEAN - MEV Sandwich Order Economics Triage");
  lines.push("");
  lines.push(`Generated: ${out.generatedAt}`);
  lines.push("");
  lines.push("Signal: No confirmed permissionless MEV, sandwich, filler, or RFQ settlement extraction route was found.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Reactor rows: ${out.summary.reactorRows}`);
  lines.push(`- Fill events: ${out.summary.fillEvents}`);
  lines.push(`- Unique fillers: ${out.summary.uniqueFillers}`);
  lines.push(`- Transfer-profit rows: ${out.summary.transferProfitRows}`);
  lines.push(`- Transfer-only positive rows: ${out.summary.transferOnlyPositiveRows}`);
  lines.push(`- Decoded order rows: ${out.summary.decodedOrderRows}`);
  lines.push(`- Sandwich simulation rows: ${out.summary.sandwichSimulationRows}`);
  lines.push(`- Exact economics rows: ${out.summary.exactEconomicsRows}`);
  lines.push(`- Watch candidates: ${out.summary.watchCandidates}`);
  lines.push(`- Route-positive: ${out.summary.routePositive}`);
  lines.push(`- Executable now: ${out.summary.executableNow}`);
  lines.push("");
  lines.push("## Top Transfer-Only Rows");
  lines.push("");
  lines.push("| Tx | Filler | Transfers | Gross | Net | Blocker |");
  lines.push("|---|---|---:|---:|---:|---|");
  for (const row of out.topTransferRows.slice(0, 20)) {
    lines.push(`| ${escapeCell(row.txHash)} | ${escapeCell(row.filler)} | ${row.transfers} | ${row.grossProfit} | ${row.netProfit} | ${escapeCell(row.blocker)} |`);
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
  const reactors = reactorRows(inputs.uniswapxMev);
  const transfers = profitRows(inputs.uniswapxProfit);
  const routerSummary = inputs.routerRfq?.summary || {};

  const fillEvents = sum(reactors, (row) => row.fillEvents);
  const uniqueFillers = sum(reactors, (row) => row.uniqueFillers);
  const transferOnlyPositiveRows = transfers.filter((row) => row.transferOnlyPositive).length;
  const decodedOrderRows = 0;
  const sandwichSimulationRows = 0;
  const exactEconomicsRows = 0;
  const watchCandidates = decodedOrderRows > 0 || sandwichSimulationRows > 0 ? 1 : 0;
  const routePositive = 0;
  const executableNow = 0;
  const topTransferRows = transfers.slice().sort((a, b) => (asNumber(b.netProfit) || 0) - (asNumber(a.netProfit) || 0));

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-mev-sandwich-order-economics.js",
    scope: "Read-only MEV/sandwich/filler exact-order economics gate over UniswapX and router/RFQ telemetry",
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
    sourceArtifacts: inputRows(inputs),
    summary: {
      mevGeneratedAt: inputs.uniswapxMev?.scannedAt || null,
      profitGeneratedAt: inputs.uniswapxProfit?.scannedAt || null,
      block: inputs.uniswapxMev?.block || inputs.uniswapxProfit?.block || null,
      reactorRows: reactors.length,
      fillEvents,
      uniqueFillers,
      transferProfitRows: transfers.length,
      transferOnlyPositiveRows,
      totalTransferGross: round(inputs.uniswapxProfit?.totalGross, 6),
      totalTransferNet: round(inputs.uniswapxProfit?.totalNet, 6),
      decodedOrderRows,
      sandwichSimulationRows,
      routerFieldBindingProofRows: asNumber(routerSummary.fieldBindingProofRows) || 0,
      routerVerifiedFieldDiffRows: asNumber(routerSummary.verifiedFieldDiffRows) || 0,
      routerLiveApprovalOrEscrowRows: asNumber(routerSummary.liveApprovalOrEscrowRows) || 0,
      routerBalanceDeltaMismatchRows: asNumber(routerSummary.balanceDeltaMismatchRows) || 0,
      exactEconomicsRows,
      watchCandidates,
      routePositive,
      executableNow,
      signedActionJustified: false,
      blocker: "UniswapX fill and transfer telemetry is active, but no row has decoded order terms, user limit price, auction curve, exact token pricing, sandwich simulation, verified settlement field drift, positive exact economics, and fork/local proof.",
    },
    reactorRows: reactors,
    transferRows: transfers,
    topTransferRows,
    topRows: topTransferRows.slice(0, 20).map((row) => ({
      protocol: "UniswapX / MEV telemetry",
      chain: "Ethereum",
      symbol: row.filler,
      pair: row.txHash,
      netUsd: row.netProfit,
      liquidityUsd: row.valueToFiller,
      routePositive: false,
      blocker: row.blocker,
    })),
    blockers: [
      "Transfer-only profit rows do not decode UniswapX order inputs, outputs, limits, or auction decay.",
      "Gas and token pricing in the source profit artifact are approximate/noisy and not exact order economics.",
      "No sandwich simulation or counterfactual route exists for the observed fills.",
      "Router/RFQ scan has no verified field diff, live approval/escrow row, balance-delta mismatch, or exact economics.",
      "No fork/local extraction proof is present.",
    ],
    requiredForRoutePositive: [
      "specific order or router settlement is decoded with maker/taker tokens, amounts, limits, deadline, recipient, and auction curve",
      "counterfactual fill/sandwich path is permissionless and executable without privileged filler role",
      "exact token prices, gas, fees, slippage, and user-loss/filler-profit economics are positive",
      "settlement field binding or pool-ordering weakness is proven on a deployed path",
      "fork/local proof demonstrates net extraction before any signed action",
    ],
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, buildMarkdown(out));
  if (!QUIET) {
    console.log(`MEV order economics: fills=${out.summary.fillEvents} transferRows=${out.summary.transferProfitRows} decodedOrders=${out.summary.decodedOrderRows} routePositive=${out.summary.routePositive}`);
    console.log(`Artifact: ${rel(OUT_JSON)}`);
  }
}

main();
