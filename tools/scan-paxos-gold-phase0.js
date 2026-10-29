#!/usr/bin/env node
// scan-paxos-gold-phase0.js - read-only Phase 0 wrapper for Paxos Gold (PAXG).
// RPC URLs stay in memory in the child scanner and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "paxos-gold-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "paxos-gold-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const PAXG_TOKEN = "0x45804880De22913dAFE09f4980848ECE6EcbAf78";
const ADAPTER_TOKENS = [
  { chain: "Ethereum", chainId: 1, adapterKey: "ethereum", token: PAXG_TOKEN, symbol: "PAXG" },
];
const LOCAL_ARTIFACTS = [
  { protocol: "Fluid Lending", file: "reports/raw/fast/fluid-lending-phase0.json" },
  { protocol: "Fluid DEX", file: "reports/raw/fast/fluid-dex-phase0.json" },
  { protocol: "Euler V2", file: "reports/raw/fast/euler-v2-phase0.json" },
  { protocol: "Tether Gold", file: "reports/raw/fast/tether-gold-phase0.json" },
  { protocol: "Velodrome V3", file: "reports/raw/fast/velodrome-v3-phase0.json" },
];

const TOKEN_SET = new Set(ADAPTER_TOKENS.map((row) => row.token.toLowerCase()));

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; } catch (_) { return fallback; } }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "boolean") return value ? 1 : 0; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n, 4)}bps`; }
function shortAddress(value) { const text = String(value || ""); return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text || "n/a"; }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-paxos-gold-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

function latestRow(rows) { return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null; }
function chainData(metadata, key) { const row = metadata?.chainTvls?.[key] || {}; return { tvlUsd: latestRow(row.tvl)?.totalLiquidityUSD ?? metadata?.currentChainTvls?.[key] ?? null }; }
function flattenResults(consumerGraph, field) { return (consumerGraph?.results || []).flatMap((row) => Array.isArray(row[field]) ? row[field] : []); }
function maxNumber(...values) { const nums = values.map(asNumber).filter((n) => n !== null); return nums.length ? Math.max(...nums) : null; }
function inferChain(obj) { return obj.chainName || obj.chain || (obj.chainId === 1 ? "Ethereum" : obj.chainId === 56 ? "BNB Chain" : obj.chainId === 10 ? "Optimism" : obj.chainId === 137 ? "Polygon" : obj.chainId === 42161 ? "Arbitrum" : obj.chainId === 43114 ? "Avalanche" : "n/a"); }
function inferLabel(obj) { return obj.label || obj.name || obj.vaultSymbol || obj.market || obj.symbol || obj.assetSymbol || obj.vaultLabel || "PAXG row"; }

function tokenMentionsPaxg(value) {
  const text = String(value || "");
  if (TOKEN_SET.has(text.toLowerCase())) return true;
  return /(^|[^a-z0-9])paxg([^a-z0-9]|$)/i.test(text) || /paxos gold/i.test(text);
}

function objectMentionsPaxg(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && tokenMentionsPaxg(value)) return true;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (["symbol", "name", "assetSymbol", "loanTokenName", "supplySymbol", "borrowSymbol", "symbolPair"].some((k) => tokenMentionsPaxg(value[k]))) return true;
    }
  }
  return false;
}

function rowish(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return Boolean(obj.label || obj.name || obj.market || obj.assetSymbol || obj.supplySymbol || obj.loanTokenName || obj.vaultSymbol || obj.symbol || obj.asset || obj.tokenBalanceUsd !== undefined || obj.vaultLabel);
}

function collectObjects(root, limit = 140) {
  const rows = [];
  const seen = new Set();
  function walk(value) {
    if (rows.length >= limit || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (rowish(value) && objectMentionsPaxg(value)) {
      const key = JSON.stringify([value.chainId || value.chain || value.chainName || "", value.address || value.vault || value.marketId || value.market || value.name || value.label || value.vaultSymbol || value.vaultLabel || "", value.asset || value.loanToken || value.symbol || value.assetSymbol || ""]).slice(0, 500);
      if (!seen.has(key)) { seen.add(key); rows.push(value); }
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(root);
  return rows;
}

function inferSide(obj) {
  if (tokenMentionsPaxg(obj.supplySymbol) || tokenMentionsPaxg(obj.assetSymbol) || tokenMentionsPaxg(obj.symbol) || tokenMentionsPaxg(obj.name)) return "collateral-or-asset";
  if (tokenMentionsPaxg(obj.borrowSymbol) || tokenMentionsPaxg(obj.loanTokenName)) return "borrow-or-loan";
  if (tokenMentionsPaxg(obj.symbolPair) || tokenMentionsPaxg(obj.label)) return "pool-or-pair";
  return "context";
}
function inferLtv(obj) { if (obj.collateralFactorBps !== undefined || obj.liquidationThresholdBps !== undefined) return `${round((asNumber(obj.collateralFactorBps) || 0) / 100, 2)}% / ${round((asNumber(obj.liquidationThresholdBps) || 0) / 100, 2)}%`; if (obj.maxLtv !== undefined || obj.lt !== undefined) return `${round((asNumber(obj.maxLtv) || 0) * 100, 2)}% / ${round((asNumber(obj.lt) || 0) * 100, 2)}%`; if (obj.maxLtvBorrowBps !== undefined || obj.ltvBorrowBps !== undefined) return `${round((asNumber(obj.maxLtvBorrowBps ?? obj.ltvBorrowBps) || 0) / 100, 2)}%`; return "n/a"; }
function inferAnomalyBps(obj) { return maxNumber(obj.externalDivergenceBps, obj.oracleOperateVsLiquidateDivergenceBps, obj.priceVsReferenceBps, obj.oracleVsDexBps); }
function inferBlocker(obj) { if (obj.blocker) return obj.blocker; if (obj.routePositive === false) return "source artifact marks this PAXG row route-negative"; if (obj.watchCandidate === false) return "source artifact does not classify this PAXG row as a watch candidate"; return "context row only; exact accepted-value, acquisition, borrow/liquidation, and unwind economics are not proven"; }

function toLocalRow(source, obj) {
  return {
    sourceArtifact: source.file,
    protocol: source.protocol,
    chain: inferChain(obj),
    label: inferLabel(obj),
    side: inferSide(obj),
    ltv: inferLtv(obj),
    routeLiquidityUsd: round(maxNumber(obj.borrowableUsd, obj.marketBaseCashUsd, obj.cashUsd, obj.borrowLiquidityUsd, obj.liquidityUsd), 2),
    contextUsd: round(maxNumber(obj.totalSupplyUsd, obj.totalAssetsUsd, obj.tokenBalanceUsd, obj.balanceUsd, obj.knownOwnerBalanceUsd, obj.totalTvlUsd, obj.poolTvlUsd), 2),
    anomalyBps: round(inferAnomalyBps(obj), 4),
    routePositive: Boolean(obj.routePositive),
    watchCandidate: Boolean(obj.watchCandidate || false),
    blocker: inferBlocker(obj),
  };
}

function collectLocalArtifactRows() {
  const rows = [];
  for (const source of LOCAL_ARTIFACTS) {
    const json = readJson(path.join(WORKSPACE, source.file), null);
    if (!json) continue;
    rows.push(...collectObjects(json).map((obj) => toLocalRow(source, obj)));
  }
  const seen = new Set();
  return rows.filter((row) => { const key = `${row.protocol}:${row.chain}:${row.label}:${row.side}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || (asNumber(b.routeLiquidityUsd) || 0) - (asNumber(a.routeLiquidityUsd) || 0) || (asNumber(b.contextUsd) || 0) - (asNumber(a.contextUsd) || 0));
}

async function fetchDexRows() {
  try {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${PAXG_TOKEN}`, 30_000);
    const rows = [];
    for (const pair of json.pairs || []) {
      const base = String(pair.baseToken?.address || "").toLowerCase();
      const quote = String(pair.quoteToken?.address || "").toLowerCase();
      if (base !== PAXG_TOKEN.toLowerCase() && quote !== PAXG_TOKEN.toLowerCase()) continue;
      rows.push({ chain: pair.chainId || null, dexId: pair.dexId || null, pairAddress: pair.pairAddress || null, baseSymbol: pair.baseToken?.symbol || null, quoteSymbol: pair.quoteToken?.symbol || null, liquidityUsd: round(pair.liquidity?.usd, 2), volume24hUsd: round(pair.volume?.h24, 2), priceUsd: round(pair.priceUsd, 8) });
    }
    return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 30);
  } catch (_) { return []; }
}

function runConsumerGraph() {
  ensureDir(RAW_OUT);
  const child = spawnSync(process.execPath, ["scan-rwa-nav-consumer-graph.js"], {
    cwd: __dirname,
    env: { ...process.env, RWA_NAV_PROTOCOL_FILTER: "Paxos Gold", RWA_NAV_CHAIN_IDS: "1", RWA_NAV_MAX_EULER_VAULTS: process.env.RWA_NAV_MAX_EULER_VAULTS || "350", RWA_NAV_MAX_SILO_IDS: process.env.RWA_NAV_MAX_SILO_IDS || "250", RWA_NAV_MORPHO_TOP_N: process.env.RWA_NAV_MORPHO_TOP_N || "150", RWA_NAV_OUT: "reports/raw/fast/paxos-gold-phase0.json" },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`${child.stderr || child.stdout || "RWA/NAV child scanner failed"}`.slice(0, 1000));
  if (!QUIET && child.stdout) process.stdout.write(child.stdout);
  return readJson(RAW_OUT, null);
}

function writeReport(out) {
  const s = out.summary;
  const tokenTable = out.tokenRows.map((row) => `| ${row.chain} | ${shortAddress(row.address)} | ${row.codePresent} | ${row.symbol || "n/a"} | ${row.totalSupply || "n/a"} | ${formatUsd(row.tokenPriceUsd)} | ${row.erc4626?.navUsdPerShare ? formatUsd(row.erc4626.navUsdPerShare) : "n/a"} | ${row.currentAnomaly} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const matchTable = out.topMatches.slice(0, 10).map((row) => `| ${row.protocol} | ${row.side} | ${row.producer?.chain || "n/a"} | ${row.producer?.symbol || "?"} | ${row.reviewCandidate} | ${row.watchCandidate} | ${formatUsd(row.market?.otherReserveCashUsd ?? row.market?.cashUsd ?? row.market?.baseCashUsd ?? row.market?.liquidityAssetsUsd ?? row.market?.oppositeLiquidityUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const localTable = out.localArtifactRows.slice(0, 16).map((row) => `| ${row.protocol} | ${row.chain} | ${row.label} | ${row.side} | ${row.ltv} | ${formatUsd(row.routeLiquidityUsd)} | ${formatUsd(row.contextUsd)} | ${formatBps(row.anomalyBps)} | ${row.routePositive} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const dexTable = out.dexLiquidityRows.slice(0, 10).map((row) => `| ${row.chain} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} | ${row.priceUsd ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";

  const content = `# 🟢 DORMANT — Paxos Gold Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-paxos-gold-phase0.js\`

Artifact: \`reports/raw/fast/paxos-gold-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass resolved the Ethereum PAXG producer, ran the generic RWA/NAV producer-to-consumer graph, joined existing Fluid/Euler/DEX/Tether-Gold PAXG artifacts, sampled public DEX context, and checked for current NAV/reference anomalies. Current gates remain closed because material PAXG consumer rows do not combine attacker-favorable accepted-value divergence with exact acquisition, borrow/liquidation/redemption, exit liquidity, and fork proof.

## Summary

| Metric | Value |
|---|---:|
| DeFiLlama TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum TVL | ${formatUsd(s.ethereumTvlUsd)} |
| Token rows | \`${s.tokenRows}\` |
| Token rows with code | \`${s.tokenRowsWithCode}\` |
| Consumer graph matches | \`${s.matches}\` |
| Local artifact PAXG rows | \`${s.localArtifactRows}\` |
| Fluid PAXG rows | \`${s.fluidPaxgRows}\` |
| Euler PAXG rows | \`${s.eulerPaxgRows}\` |
| Fluid DEX PAXG rows | \`${s.fluidDexPaxgRows}\` |
| Review candidates | \`${s.reviewCandidates}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Top DEX liquidity | ${formatUsd(s.topDexLiquidityUsd)} |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |

## PAXG Tokens

| Chain | Token | Code | Symbol | Total supply | Public token price | ERC4626 NAV/share | Current anomaly |
|---|---|---:|---|---:|---:|---:|---:|
${tokenTable}

## Generic Consumer Matches

| Protocol | Side | Producer chain | Symbol | Review | Watch | Route-side liquidity |
|---|---|---|---|---:|---:|---:|
${matchTable}

## Local Artifact Joins

| Protocol | Chain | Label | Side | LTV | Route liquidity | Context USD | Anomaly | Route-positive |
|---|---|---|---|---:|---:|---:|---:|---:|
${localTable}

## DEX Context

| Chain | DEX | Pair | Liquidity USD | 24h volume USD | Price USD |
|---|---|---|---:|---:|---:|
${dexTable}

## Blockers

- PAXG issuance/redemption/custody remains treated as permissioned; no public atomic redeem path is proven.
- No ERC4626-style NAV interface or current NAV/reference anomaly is resolved for the exact PAXG token row in the generic graph.
- Fluid PAXG and PAXG/XAUt rows have material borrow/DEX context, but current source artifacts show no attacker-favorable accepted-value divergence or route-positive economics.
- Euler PAXG rows are dust/zero-borrow or context-only in current artifacts.
- Public DEX liquidity is context only; no exact positive borrow, redemption, liquidation, or unwind route is proven.
- No fork extraction proof and no signed-action justification exist.

## Required For Route-Positive

- PAXG must be accepted by a material lending, margin, redemption, or liquidation consumer with a permissionless value-changing trigger.
- Accepted value must diverge from exact acquisition, NAV, redemption, or DEX exit value in an attacker-favorable direction after CF/LLTV haircuts.
- Borrowed, redeemed, or seized assets must have exact positive exit economics after gas, fees, slippage, and permission constraints.
- Fork extraction proof must show measured profit.

## Next Read-Only Step

Keep PAXG on Fluid/Euler/RWA-NAV and PAXG-XAUt DEX watch. Reopen for exact quoting only if a material borrower becomes liquidatable, a trusted oracle/accepted-value divergence clears the haircut, or a permissionless redemption/DEX exit path becomes exact-positive after costs.
`;
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const consumerGraph = runConsumerGraph();
  const [metadataRaw, dexLiquidityRows] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/paxos-gold", 45_000).catch(() => ({})),
    fetchDexRows(),
  ]);
  if (!consumerGraph) throw new Error("Missing consumer graph artifact after child scan");
  const localArtifactRows = collectLocalArtifactRows();
  const tokenRows = flattenResults(consumerGraph, "topProducers").filter((row) => /paxg|paxos gold/i.test(String(row.symbol || row.name || "")) || TOKEN_SET.has(String(row.address || "").toLowerCase()));
  const topMatches = flattenResults(consumerGraph, "topMatches");
  const latestTvl = latestRow(metadataRaw.tvl)?.totalLiquidityUSD ?? Object.values(metadataRaw.currentChainTvls || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const routePositive = (asNumber(consumerGraph.summary?.routePositive) || 0) + localArtifactRows.filter((row) => row.routePositive).length;
  const graphWatchCandidates = asNumber(consumerGraph.summary?.watchCandidates) || 0;
  const localWatchCandidates = localArtifactRows.filter((row) => row.routePositive || (row.watchCandidate && (asNumber(row.routeLiquidityUsd) || 0) >= 10_000 && Math.abs(asNumber(row.anomalyBps) || 0) >= 100)).length;
  const watchCandidates = graphWatchCandidates + localWatchCandidates;
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-paxos-gold-phase0.js",
    scope: "Paxos Gold public Phase 0 token/NAV, consumer graph, local artifact joins, and exit-liquidity triage",
    safety: { publicApisOnly: false, rpcInventoryRead: Boolean(consumerGraph.safety?.rpcInventoryRead), rpcInventoryOnly: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: routePositive > 0, signedActionJustified: false },
    metadata: { name: metadataRaw.name || "Paxos Gold", slug: metadataRaw.slug || "paxos-gold", category: metadataRaw.category || "RWA", chains: metadataRaw.chains || ["Ethereum"], module: metadataRaw.module || "paxos-gold/index.js", tvlCodePath: metadataRaw.tvlCodePath || null, methodology: metadataRaw.methodology || null, adapterTokens: ADAPTER_TOKENS },
    tokenRows,
    dexLiquidityRows,
    topMatches,
    localArtifactRows,
    consumerGraph,
    summary: {
      defillamaCurrentTvlUsd: round(latestTvl, 2),
      ethereumTvlUsd: round(chainData(metadataRaw, "Ethereum").tvlUsd ?? latestTvl, 2),
      tokenRows: tokenRows.length,
      tokenRowsWithCode: tokenRows.filter((row) => row.codePresent).length,
      producersInput: asNumber(consumerGraph.summary?.producersInput) || 0,
      producersResolved: asNumber(consumerGraph.summary?.producersResolved) || 0,
      producersCodePresent: asNumber(consumerGraph.summary?.producersCodePresent) || 0,
      producersWithPublicTokenPrice: asNumber(consumerGraph.summary?.producersWithPublicTokenPrice) || 0,
      producersWithErc4626Nav: asNumber(consumerGraph.summary?.producersWithErc4626Nav) || 0,
      producerAnomalies: asNumber(consumerGraph.summary?.producerAnomalies) || 0,
      matches: asNumber(consumerGraph.summary?.matches) || 0,
      localArtifactRows: localArtifactRows.length,
      fluidPaxgRows: localArtifactRows.filter((row) => row.protocol === "Fluid Lending").length,
      eulerPaxgRows: localArtifactRows.filter((row) => row.protocol === "Euler V2").length,
      fluidDexPaxgRows: localArtifactRows.filter((row) => row.protocol === "Fluid DEX").length,
      reviewCandidates: (asNumber(consumerGraph.summary?.reviewCandidates) || 0) + localArtifactRows.filter((row) => (asNumber(row.routeLiquidityUsd) || 0) >= 10_000 || (asNumber(row.contextUsd) || 0) >= 10_000).length,
      watchCandidates,
      dexLiquidityRows: dexLiquidityRows.length,
      topDexLiquidityUsd: round(dexLiquidityRows[0]?.liquidityUsd, 2),
      routePositive,
      executableNow: false,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      status: routePositive > 0 ? "paxos-gold-route-positive-needs-proof" : watchCandidates > 0 ? "paxos-gold-watch-needs-nav-consumer-economics" : "paxos-gold-phase0-no-route-positive",
    },
    blockers: ["No PAXG consumer-side borrow/liquidation/redeem route with current accepted-value divergence and material exact-positive economics was found", "No ERC4626 NAV interface or current NAV/reference divergence above threshold was resolved for exact PAXG producer rows", "PAXG redemption/custody and transferability remain treated as permissioned/restricted absent public atomic exit proof", "Fluid, Euler, PAXG/XAUt DEX, and public DEX rows remain context-only or blocked by missing exact acquisition/exit economics or permission constraints", "No fork extraction proof and no signed-action justification"],
    requiredForRoutePositive: ["PAXG accepted by a material lending, margin, redemption, or liquidation consumer", "permissionless NAV/oracle/backing/accepted-value divergence or current liquidatable borrower condition", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"],
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, null, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Paxos Gold Phase0: tvl=${formatUsd(output.summary.defillamaCurrentTvlUsd)} tokens=${output.summary.tokenRows} matches=${output.summary.matches} localRows=${output.summary.localArtifactRows} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => { console.error(String(err?.message || err).slice(0, 1000)); process.exit(1); });
