#!/usr/bin/env node
// scan-public-lead-consumer-joins.js - artifact-only join from current public lead tokens to existing consumer graphs.
// No RPC, env, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const IN = path.join(WORKSPACE, "reports", "raw", "fast", "current-profit-lead-triage.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "public-lead-consumer-joins.json");

const INPUTS = [
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["erc4626-joiner", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["usdt0-consumers", "reports/raw/fast/usdt0-consumer-routes.json"],
  ["rwa-nav", "reports/raw/fast/rwa-nav-consumer-graph.json"],
  ["centrifuge-nav", "reports/raw/fast/centrifuge-nav-consumer-graph.json"],
  ["pendle-pt-multichain", "reports/raw/fast/pendle-pt-multichain-consumer-graph.json"],
  ["hyperliquid-linked", "reports/raw/fast/hyperliquid-linked-token-consumers.json"],
];

const COMMON_SYMBOLS = new Set(["USDC", "USDT", "DAI", "WETH", "ETH", "WBTC", "USDS", "PYUSD", "FRAX", "GHO"]);
const MAX_MATCHES_PER_TOKEN_PER_FILE = Number(process.env.PUBLIC_LEAD_JOIN_MAX_MATCHES_PER_FILE || "20");

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ""));
}

function norm(value) {
  return isAddress(value) ? String(value).toLowerCase() : null;
}

function num(value) {
  const n = Number(String(value ?? "").replace(/[$,%_\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 4) {
  const n = num(value);
  if (n === null) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function compact(value, max = 80) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function interestingToken(lead, assessment) {
  const symbol = assessment.token?.symbol || lead.lead?.symbol || "";
  const tags = new Set(assessment.tags || []);
  if (tags.has("missing-market-price")) return true;
  if (assessment.erc4626?.isErc4626Like) return true;
  if (assessment.compound?.isCompoundLike) return true;
  if (!COMMON_SYMBOLS.has(String(symbol).toUpperCase())) return true;
  return false;
}

function leadTokens(artifact) {
  const out = [];
  for (const lead of artifact.leads || []) {
    for (const assessment of lead.tokenAssessments || []) {
      const address = norm(assessment.address || assessment.token?.address);
      if (!address || !interestingToken(lead, assessment)) continue;
      out.push({
        address,
        lead: lead.label,
        project: lead.lead?.project || lead.lead?.name || null,
        chain: lead.chain,
        poolSymbol: lead.lead?.symbol || null,
        apyPct: round(lead.lead?.apyPct, 4),
        tokenSymbol: assessment.token?.symbol || null,
        tokenName: assessment.token?.name || null,
        tags: assessment.tags || [],
        topDexLiquidityUsd: round(assessment.topDexLiquidityUsd, 2),
        routePositive: Boolean(assessment.routePositive),
      });
    }
  }
  const seen = new Set();
  return out.filter((row) => {
    const key = `${row.address}:${row.lead}:${row.chain}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contextSummary(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = [
    "id", "protocol", "chain", "chainId", "consumerType", "side", "symbol", "pair", "assetSymbol",
    "collateralSymbol", "borrowSymbol", "token", "asset", "collateral", "borrowAsset",
    "ltv", "lltv", "liquidationThreshold", "cashUsd", "borrowCashUsd", "routeLiquidityUsd",
    "maxDexLiquidityUsd", "maxBorrowCashUsd", "bestNetEdgeUsd", "bestNetUsd", "routePositive",
    "watchCandidate", "signedActionJustified",
  ];
  const out = {};
  for (const field of fields) {
    if (obj[field] !== undefined && typeof obj[field] !== "object") out[field] = compact(obj[field]);
  }
  if (obj.facts && typeof obj.facts === "object") {
    for (const field of ["symbol", "ltv", "cashUsd", "routeCandidates", "oracleVsRefPct", "priceUsd"]) {
      if (obj.facts[field] !== undefined) out[`facts.${field}`] = compact(obj.facts[field]);
    }
  }
  if (Array.isArray(obj.blockers)) out.blockers = obj.blockers.slice(0, 3).map((x) => compact(x, 140));
  return out;
}

function contextRoutePositive(ctx) {
  return ctx.routePositive === true || ctx.routePositive === "true" || ctx.routePositive === 1 || ctx.routePositive === "1";
}

function contextWatch(ctx) {
  return contextRoutePositive(ctx) || ctx.watchCandidate === true || ctx.watchCandidate === "true" || ctx.watchCandidate === 1 || ctx.watchCandidate === "1";
}

function contextLiquidity(ctx) {
  return Math.max(
    num(ctx.cashUsd) || 0,
    num(ctx.borrowCashUsd) || 0,
    num(ctx.routeLiquidityUsd) || 0,
    num(ctx.maxDexLiquidityUsd) || 0,
    num(ctx.maxBorrowCashUsd) || 0,
    num(ctx["facts.cashUsd"]) || 0,
  );
}

function findMatches(data, token, source) {
  const matches = [];
  const wanted = token.address;
  function walk(value, objectPath, parent) {
    if (matches.length >= MAX_MATCHES_PER_TOKEN_PER_FILE) return;
    if (typeof value === "string") {
      if (norm(value) === wanted) {
        const ctx = contextSummary(parent);
        if (!Object.keys(ctx).length) return;
        matches.push({
          source,
          path: objectPath,
          context: ctx,
          routePositive: contextRoutePositive(ctx),
          watchCandidate: contextWatch(ctx),
          maxContextLiquidityUsd: round(contextLiquidity(ctx), 2),
        });
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${objectPath}[${i}]`, parent);
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, objectPath ? `${objectPath}.${key}` : key, value);
  }
  walk(data, "", null);
  return matches;
}

function main() {
  const triage = readJson(IN, {});
  const tokens = leadTokens(triage);
  const rows = [];
  const loadedInputs = [];

  for (const [source, rel] of INPUTS) {
    const abs = path.join(WORKSPACE, rel);
    const data = readJson(abs, null);
    if (!data) continue;
    loadedInputs.push(rel);
    for (const token of tokens) {
      const matches = findMatches(data, token, source);
      if (!matches.length) continue;
      rows.push({
        ...token,
        source,
        joinCount: matches.length,
        routePositive: matches.some((m) => m.routePositive),
        watchCandidate: matches.some((m) => m.watchCandidate),
        maxContextLiquidityUsd: Math.max(...matches.map((m) => m.maxContextLiquidityUsd || 0)),
        matches,
      });
    }
  }

  rows.sort((a, b) => (b.routePositive - a.routePositive)
    || (b.watchCandidate - a.watchCandidate)
    || ((b.maxContextLiquidityUsd || 0) - (a.maxContextLiquidityUsd || 0))
    || (b.joinCount - a.joinCount));

  const routeRows = rows.filter((row) => row.routePositive);
  const watchRows = rows.filter((row) => row.watchCandidate && !row.routePositive);
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-public-lead-consumer-joins.js",
    scope: "Artifact-only join from current public lead tokens to existing consumer graphs",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routeRows.length > 0,
      signedActionJustified: false,
    },
    inputs: {
      triage: "reports/raw/fast/current-profit-lead-triage.json",
      consumerArtifacts: loadedInputs,
    },
    summary: {
      inputGeneratedAt: triage.generatedAt || null,
      leadTokensConsidered: tokens.length,
      consumerArtifactsLoaded: loadedInputs.length,
      joinedRows: rows.length,
      watchCandidates: watchRows.length,
      routePositive: routeRows.length,
      executableNow: 0,
      signedActionJustified: false,
      maxContextLiquidityUsd: rows.length ? Math.max(...rows.map((row) => row.maxContextLiquidityUsd || 0)) : 0,
      blocker: routeRows.length ? null : "No current public lead token join has route-positive consumer economics in existing artifacts.",
    },
    topRows: rows.slice(0, 30),
    rows,
    consideredTokens: tokens,
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");
  console.log(`Public lead consumer joins: tokens=${tokens.length} joins=${rows.length} watch=${watchRows.length} routePositive=${routeRows.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main();
