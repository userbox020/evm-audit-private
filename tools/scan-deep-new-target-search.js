#!/usr/bin/env node
// Deep public target search for fresh route-first audit candidates.
// Public APIs and local non-secret artifacts only. Never reads rpc_endpoints.txt or env/private-key files.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORT_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "prefilter-deep-new-target-search-2026-06-24.json");
const OUT_MD = path.join(REPORT_DIR, "prefilter-deep-new-target-search-2026-06-24.md");
const PUBLIC_DISCOVERY = path.join(RAW_DIR, "public-audit-target-discovery.json");
const PRIOR_QUEUE = path.join(RAW_DIR, "prefilter-new-target-route-research-2026-06-24.json");

const ACCESSIBLE_EVM = new Set([
  "ethereum", "ethereum mainnet", "base", "arbitrum", "arbitrum one", "optimism", "bnb", "binance", "bsc", "polygon", "avalanche", "gnosis", "linea", "scroll", "celo", "fantom", "blast", "mantle", "sonic", "ink", "unichain", "world chain", "bera", "berachain",
]);
const ACCESSIBLE_NON_EVM = new Set(["solana", "sui", "aptos", "stellar", "hyperliquid"]);
const PROCESSED_SLUGS = new Set([
  "openeden-tbill", "unit", "lighter-bridge", "aster-bridge", "lorenzo-susd1", "lorenzo-susd1-plus", "digift", "gaib", "ember-protocol", "mainstreet", "overnight-finance", "fira",
  "ccip", "spark", "spark-savings", "spark-liquidity-layer", "etherfi", "ether-fi", "ether-fi-stake", "ondo", "ondo-yield-assets", "kelp", "re", "3f",
]);
const EXCLUDED_CATEGORIES = new Set(["CEX", "Centralized Exchange", "Chain", "Infrastructure", "NFT Marketplace"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const text = readText(file).replace(/^\uFEFF/, ""); return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function safe(value, max = 140) { return String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, max); }
function uniq(items) { return [...new Set((items || []).filter(Boolean))]; }
function normalizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || null;
}
function canonicalSlug(value) {
  const n = normalizeSlug(value);
  return n ? n.replace(/-plus$/g, "").replace(/-finance$/g, "").replace(/-protocol$/g, "") : null;
}
function formatUsd(value) {
  const n = asNumber(value);
  if (n === null) return "n/a";
  if (Math.abs(n) >= 1e9) return `$${round(n / 1e9, 3)}B`;
  if (Math.abs(n) >= 1e6) return `$${round(n / 1e6, 3)}M`;
  if (Math.abs(n) >= 1e3) return `$${round(n / 1e3, 3)}K`;
  return `$${round(n, 2)}`;
}
function scoreLog(value, max, divisor = 1_000_000) {
  const n = Math.max(0, asNumber(value) || 0);
  if (!n) return 0;
  return Math.min(max, Math.max(0, Math.log10(n / divisor + 1) * (max / 3)));
}

async function fetchJson(url, timeoutMs = 45_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "evm-audit-deep-target-search/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function listFiles(dir, suffixes) {
  const rows = [];
  function walk(current) {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) walk(full);
      else if (suffixes.some((s) => item.name.toLowerCase().endsWith(s))) rows.push(path.relative(WORKSPACE, full).replace(/\\/g, "/"));
    }
  }
  if (fs.existsSync(dir)) walk(dir);
  return rows;
}

function buildCoverage() {
  const files = [
    ...listFiles(REPORT_DIR, [".md"]),
    ...listFiles(RAW_DIR, [".json"]),
  ];
  const normalized = files.map((file) => {
    const norm = normalizeSlug(path.basename(file).replace(/\.(md|json)$/i, "")) || "";
    return { file, norm, compact: norm.replace(/-/g, "") };
  });
  const prior = readJson(PRIOR_QUEUE, {});
  const publicDiscovery = readJson(PUBLIC_DISCOVERY, {});
  const priorSlugs = new Set((prior.rankedCandidates || []).map((r) => normalizeSlug(r.slug || r.name)).filter(Boolean));
  const localQueueSlugs = new Set([
    ...(publicDiscovery.phase0Queue || []),
    ...(publicDiscovery.targetedRefreshQueue || []),
    ...(publicDiscovery.consumerJoinFirst || []),
  ].map((r) => normalizeSlug(r.slug || r.project || r.name)).filter(Boolean));
  return { files: normalized, priorSlugs, localQueueSlugs };
}

function coverageFor(row, coverage) {
  const slug = normalizeSlug(row.slug || row.project || row.name);
  const can = canonicalSlug(slug);
  const name = normalizeSlug(row.name || row.project || slug);
  const parts = uniq([...(slug || "").split("-"), ...(name || "").split("-")]).filter((x) => x.length >= 4);
  const firstTwo = (name || slug || "").split("-").slice(0, 2).join("-");
  const keys = uniq([slug, can, name, firstTwo, ...parts].filter((x) => x && x.length >= 4));
  const matches = [];
  function isBoundaryMatch(fileNorm, key) {
    return fileNorm === key || fileNorm.startsWith(`${key}-`) || fileNorm.endsWith(`-${key}`) || fileNorm.includes(`-${key}-`);
  }
  for (const file of coverage.files) {
    if (keys.some((key) => {
      const compactKey = key.replace(/-/g, "");
      return isBoundaryMatch(file.norm, key) || (compactKey.length >= 4 && (file.compact.startsWith(compactKey) || file.compact.includes(compactKey)));
    })) matches.push(file.file);
  }
  const processed = PROCESSED_SLUGS.has(slug) || PROCESSED_SLUGS.has(can) || coverage.priorSlugs.has(slug) || coverage.priorSlugs.has(can);
  const queuedBefore = coverage.localQueueSlugs.has(slug) || coverage.localQueueSlugs.has(can);
  let state = "fresh-or-uncovered";
  if (processed || matches.length >= 2) state = "already-processed-or-covered";
  else if (matches.length === 1 || queuedBefore) state = "light-local-context";
  return { state, matches: matches.slice(0, 8), matchCount: matches.length, processed, queuedBefore };
}

function chainContext(chains) {
  const rows = (chains || []).map((c) => String(c || "").trim()).filter(Boolean);
  const accessibleEvm = rows.filter((c) => ACCESSIBLE_EVM.has(c.toLowerCase()));
  const accessibleNonEvm = rows.filter((c) => ACCESSIBLE_NON_EVM.has(c.toLowerCase()));
  const blockedOrCaveat = rows.filter((c) => !ACCESSIBLE_EVM.has(c.toLowerCase()) && !ACCESSIBLE_NON_EVM.has(c.toLowerCase()));
  return { chains: rows, accessibleEvm, accessibleNonEvm, blockedOrCaveat, accessibleScore: Math.min(18, accessibleEvm.length * 4 + accessibleNonEvm.length * 2 + (accessibleEvm.length ? 6 : 0)) };
}

function surfaceFor(category, name = "") {
  const text = `${category || ""} ${name || ""}`.toLowerCase();
  if (/bridge|messaging|interop|oft|cross.?chain/.test(text)) return {
    surface: "bridge-proof-custody-consumer",
    weight: 27,
    routeGraph: "custody/backing or proof state -> wrapped asset -> lending/DEX consumer -> borrow/unlock/exit",
    checks: ["map custody and wrapped supply", "verify proof/domain/nonce/token/recipient binding", "join wrapped assets to lending and DEX consumers"],
  };
  if (/lending|borrow|money market|cdp|stablecoin|synthetic/.test(text)) return {
    surface: "lending-oracle-liquidation",
    weight: 28,
    routeGraph: "collateral token -> oracle/accounting value -> borrow/liquidation path -> DEX/stable exit",
    checks: ["map markets and oracle sources", "query caps/pauses/borrow cash", "compare accepted value to market/redeem value"],
  };
  if (/rwa|real.?world|treasur|bill|credit|nav|fund|basis/.test(text)) return {
    surface: "rwa-nav-consumer-join",
    weight: 25,
    routeGraph: "RWA receipt -> NAV/rate provider -> accepted-value consumer -> borrow/redeem/exit",
    checks: ["resolve exact receipt and NAV contracts", "join receipts to lending/oracle consumers", "check redemption/transfer gates and DEX exits"],
  };
  if (/yield|vault|allocator|erc.?4626|farm|earn|restak|liquid staking|lst|lrt/.test(text)) return {
    surface: "vault-yield-allocator",
    weight: 22,
    routeGraph: "vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind",
    checks: ["resolve vault/share token", "probe ERC4626/share-rate/donation semantics", "join shares to lending and DEX consumers"],
  };
  if (/derivative|perp|option|future|margin|leverage/.test(text)) return {
    surface: "perps-keeper-oracle-margin",
    weight: 20,
    routeGraph: "position/oracle mark -> margin account -> liquidation/settlement -> stable exit",
    checks: ["map keeper callbacks and oracle freshness", "query insurance/collateral pools", "check liquidation and settlement math"],
  };
  if (/dex|amm|clmm|liquidity|swap|hook|v4|ve\(3,3\)|ve33/.test(text)) return {
    surface: "dex-hook-lp-oracle",
    weight: 14,
    routeGraph: "pool or LP share -> oracle/rate consumer -> borrow/redeem/fee path",
    checks: ["map pool factories and hooks", "join LP/rate provider to consumers", "check manipulable low-liquidity oracle use"],
  };
  return {
    surface: "generic-route-discovery",
    weight: 9,
    routeGraph: "producer asset -> accepted value -> consumer -> exit liquidity",
    checks: ["resolve deployed contracts", "identify producer/consumer edges", "rank by liquidity and route economics"],
  };
}

function auditScore(value) {
  if (value === 0 || value === "0" || value === false) return 8;
  if (Array.isArray(value) && value.length === 0) return 8;
  const n = asNumber(value);
  if (n === 0) return 8;
  if (n === 1) return 4;
  return 0;
}

function protocolScore(row, coverage) {
  const tvl = asNumber(row.tvl || row.tvlUsd || row.currentTvlUsd) || 0;
  const ctx = chainContext(row.chains || []);
  const surf = surfaceFor(row.category, row.name || row.slug);
  const cov = coverageFor(row, coverage);
  const change1d = Math.abs(asNumber(row.change_1d || row.change1dPct) || 0);
  const change7d = Math.abs(asNumber(row.change_7d || row.change7dPct) || 0);
  let score = 0;
  score += scoreLog(tvl, 26, 1_000_000);
  score += surf.weight;
  score += ctx.accessibleScore;
  score += auditScore(row.audits || row.audit_links);
  score += Math.min(8, change1d * 0.8 + change7d * 0.25);
  if (cov.state === "fresh-or-uncovered") score += 20;
  if (cov.state === "light-local-context") score += 9;
  if (cov.state === "already-processed-or-covered") score -= 25;
  if (cov.processed) score -= 20;
  if (!ctx.accessibleEvm.length && !ctx.accessibleNonEvm.length) score -= 22;
  if ((row.category && EXCLUDED_CATEGORIES.has(row.category)) || tvl < 5_000_000) score -= 18;
  return { score: round(score, 2), tvlUsd: round(tvl, 2), chainContext: ctx, surface: surf, coverage: cov };
}

function yieldSurface(row) {
  const symbol = `${row.symbol || ""} ${row.project || ""}`;
  const base = surfaceFor("Yield", symbol);
  if (row.ilRisk === "yes") return { ...base, surface: "lp-vault-yield-allocator", weight: base.weight - 3, routeGraph: "LP/vault share -> strategy accounting -> LP/consumer/exits -> unwind" };
  if (row.stablecoin) return { ...base, surface: "stable-yield-depeg-oracle", weight: base.weight + 3, routeGraph: "stable deposit/receipt -> peg/NAV assumption -> lending or DEX exit" };
  return base;
}

function yieldScore(row, coverage) {
  const tvl = asNumber(row.tvlUsd || row.tvl) || 0;
  const apy = asNumber(row.apy || row.apyPct) || 0;
  const ctx = chainContext([row.chain].filter(Boolean));
  const cov = coverageFor({ slug: row.project, name: row.project }, coverage);
  const surf = yieldSurface(row);
  let score = 0;
  score += Math.min(24, Math.log10(Math.max(1, apy + 1)) * 9);
  score += scoreLog(tvl, 18, 100_000);
  score += surf.weight;
  score += ctx.accessibleScore;
  if (cov.state === "fresh-or-uncovered") score += 14;
  if (cov.state === "light-local-context") score += 6;
  if (cov.state === "already-processed-or-covered") score -= 18;
  if (tvl < 100_000) score -= 12;
  if (!ctx.accessibleEvm.length && !ctx.accessibleNonEvm.length) score -= 18;
  if (apy < 20 && tvl < 1_000_000) score -= 10;
  return { score: round(score, 2), tvlUsd: round(tvl, 2), apyPct: round(apy, 2), chainContext: ctx, surface: surf, coverage: cov };
}

async function adapterHints(slug, modulePath) {
  const candidates = uniq([
    modulePath && String(modulePath).replace(/^projects\//, ""),
    slug && `${slug}/index.js`,
  ].filter(Boolean));
  for (const module of candidates) {
    const url = `https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/${module}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "evm-audit-deep-target-search/1.0" } });
      if (!res.ok) continue;
      const text = await res.text();
      const addresses = uniq(text.match(/0x[a-fA-F0-9]{40}/g) || []);
      const hints = [
        ["strategyAssets", /strategyAssets/i],
        ["ERC4626", /totalAssets|convertToAssets|previewRedeem|maxDeposit/i],
        ["oracle", /oracle|price|feed|rateProvider/i],
        ["bridge/custody", /bridge|escrow|custody|lock|mint|burn/i],
        ["redeem/withdraw", /redeem|withdraw|unstake|claim/i],
      ].filter(([, re]) => re.test(text)).map(([label]) => label);
      clearTimeout(timer);
      return { module, adapterFetched: true, adapterAddressCount: addresses.length, adapterHints: hints.slice(0, 6), adapterAddressSamples: addresses.slice(0, 8) };
    } catch (_) {
      clearTimeout(timer);
    }
  }
  return { module: candidates[0] || null, adapterFetched: false, adapterAddressCount: 0, adapterHints: [], adapterAddressSamples: [] };
}

function dedupe(rows, keyFn, limit) {
  const seen = new Set();
  const out = [];
  for (const row of rows.sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

async function main() {
  const coverage = buildCoverage();
  const [protocols, yields] = await Promise.all([
    fetchJson("https://api.llama.fi/protocols"),
    fetchJson("https://yields.llama.fi/pools"),
  ]);
  const protocolRows = Array.isArray(protocols) ? protocols : [];
  const yieldRows = Array.isArray(yields?.data) ? yields.data : [];
  const protocolCandidates = protocolRows.map((row) => {
    const scoring = protocolScore(row, coverage);
    const slug = normalizeSlug(row.slug || row.name);
    return {
      kind: "protocol",
      slug,
      name: safe(row.name || slug, 96),
      category: row.category || null,
      tvlUsd: scoring.tvlUsd,
      change1dPct: round(row.change_1d, 2),
      change7dPct: round(row.change_7d, 2),
      chains: scoring.chainContext.chains,
      accessibleEvmChains: scoring.chainContext.accessibleEvm,
      accessibleNonEvmChains: scoring.chainContext.accessibleNonEvm,
      blockedOrCaveatChains: scoring.chainContext.blockedOrCaveat,
      surface: scoring.surface.surface,
      routeGraph: scoring.surface.routeGraph,
      firstReadOnlyChecks: scoring.surface.checks,
      coverage: scoring.coverage,
      audits: row.audits ?? row.audit_links ?? null,
      module: row.module || row.tvlCodePath || null,
      score: scoring.score,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    };
  }).filter((row) => row.slug && row.tvlUsd >= 5_000_000 && !EXCLUDED_CATEGORIES.has(row.category));

  const yieldCandidates = yieldRows.map((row) => {
    const scoring = yieldScore(row, coverage);
    return {
      kind: "yield",
      project: safe(row.project, 96),
      slug: normalizeSlug(row.project),
      chain: row.chain || null,
      symbol: safe(row.symbol, 80),
      pool: row.pool || null,
      tvlUsd: scoring.tvlUsd,
      apyPct: scoring.apyPct,
      apyBasePct: round(row.apyBase, 2),
      stablecoin: Boolean(row.stablecoin),
      ilRisk: row.ilRisk || null,
      underlyingTokens: (row.underlyingTokens || []).slice(0, 8),
      surface: scoring.surface.surface,
      routeGraph: scoring.surface.routeGraph,
      firstReadOnlyChecks: scoring.surface.checks,
      coverage: scoring.coverage,
      accessibleEvmChains: scoring.chainContext.accessibleEvm,
      accessibleNonEvmChains: scoring.chainContext.accessibleNonEvm,
      blockedOrCaveatChains: scoring.chainContext.blockedOrCaveat,
      score: scoring.score,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    };
  }).filter((row) => row.slug && row.tvlUsd >= 100_000 && row.score > 30);

  const freshMaterialProtocols = dedupe(
    protocolCandidates.filter((r) => r.coverage.state !== "already-processed-or-covered" && r.accessibleEvmChains.length && r.tvlUsd >= 10_000_000),
    (r) => r.slug,
    40,
  );
  const highApyYieldAnomalies = dedupe(
    yieldCandidates.filter((r) => r.coverage.state !== "already-processed-or-covered" && r.accessibleEvmChains.length && r.apyPct >= 30),
    (r) => `${r.slug}:${r.chain}:${r.symbol}`,
    30,
  );
  const blockedCoverage = dedupe(
    protocolCandidates.filter((r) => r.coverage.state !== "already-processed-or-covered" && !r.accessibleEvmChains.length && r.tvlUsd >= 25_000_000),
    (r) => r.slug,
    20,
  );

  const topForEnrichment = freshMaterialProtocols.slice(0, 18);
  for (const row of topForEnrichment) {
    row.adapter = await adapterHints(row.slug, row.module);
  }

  const rankedQueue = [
    ...freshMaterialProtocols.slice(0, 18),
    ...highApyYieldAnomalies.slice(0, 10),
  ].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 20).map((row, i) => ({ rank: i + 1, ...row }));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-deep-new-target-search.js",
    agentId: "discovery-05",
    role: "discovery-prefilter",
    claimResource: "discovery/deep-new-target-search-2026-06-24",
    scope: "Deep public route-first target discovery after prior fresh-target queue completion",
    safety: {
      publicApisOnly: true,
      localArtifactsRead: true,
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
      forkJustified: false,
    },
    inputs: [
      "https://api.llama.fi/protocols",
      "https://yields.llama.fi/pools",
      "DefiLlama public adapter source for top candidates",
      "local reports/*.md coverage index",
      "local reports/raw/fast/*.json coverage index",
      "reports/raw/fast/public-audit-target-discovery.json",
      "reports/raw/fast/prefilter-new-target-route-research-2026-06-24.json",
    ],
    summary: {
      protocolRowsScanned: protocolRows.length,
      yieldRowsScanned: yieldRows.length,
      protocolCandidates: protocolCandidates.length,
      yieldCandidates: yieldCandidates.length,
      freshMaterialProtocols: freshMaterialProtocols.length,
      highApyYieldAnomalies: highApyYieldAnomalies.length,
      blockedCoverageRows: blockedCoverage.length,
      rankedQueue: rankedQueue.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
      topCandidate: rankedQueue[0]?.slug || rankedQueue[0]?.project || null,
      primaryBlocker: "This is a target discovery prefilter: no exact producer anomaly plus live extractive consumer plus positive economics has been proven yet.",
    },
    rankedQueue,
    freshMaterialProtocols: freshMaterialProtocols.slice(0, 40),
    highApyYieldAnomalies: highApyYieldAnomalies.slice(0, 30),
    blockedCoverage,
    routePositiveRows: [],
    nextRoutePositiveCriteria: [
      "Exact deployed producer address and accounting/proof/NAV anomaly is identified",
      "Exact asset joins a live consumer with material borrow, liquidation, redeem, unlock, or exit liquidity",
      "Read-only economics remain positive after LTV, caps, fees, slippage, queues, and gas",
    ],
  };

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, JSON.stringify(artifact, null, 2) + "\n");
  writeReport(artifact);
  console.log(`Deep target search: protocols=${protocolRows.length} yields=${yieldRows.length} queue=${rankedQueue.length} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT_JSON).replace(/\\/g, "/")}`);
  console.log(`Report: ${path.relative(WORKSPACE, OUT_MD).replace(/\\/g, "/")}`);
}

function rowLabel(row) {
  return row.kind === "yield" ? `${row.project} ${row.symbol || ""}`.trim() : `${row.name || row.slug}`;
}

function writeReport(artifact) {
  const lines = [];
  lines.push("# 🟢 DORMANT - Deep New Target Search");
  lines.push("");
  lines.push("Date: 2026-06-24");
  lines.push("");
  lines.push("Artifact: `reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json`");
  lines.push("");
  lines.push("Claim: `discovery/deep-new-target-search-2026-06-24` under `discovery-05`");
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push("No route-positive, low/no-own-capital target was proven by this deep search. The output is a fresh route-first queue, not a fork gate.");
  lines.push("");
  lines.push("The scanner searched broad DeFiLlama protocol and yield metadata, penalized already-processed local coverage, prioritized accessible chains and exploitable surfaces, and enriched top protocol candidates with public adapter-source hints where available.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Protocol rows scanned | \`${artifact.summary.protocolRowsScanned}\` |`);
  lines.push(`| Yield rows scanned | \`${artifact.summary.yieldRowsScanned}\` |`);
  lines.push(`| Fresh material protocol candidates | \`${artifact.summary.freshMaterialProtocols}\` |`);
  lines.push(`| High-APY yield anomalies | \`${artifact.summary.highApyYieldAnomalies}\` |`);
  lines.push(`| Blocked coverage rows | \`${artifact.summary.blockedCoverageRows}\` |`);
  lines.push(`| Ranked queue rows | \`${artifact.summary.rankedQueue}\` |`);
  lines.push("| Route-positive rows | `0` |");
  lines.push("| Executable now | `0` |");
  lines.push("| Signed action justified | `false` |");
  lines.push("");
  lines.push("## Top Route-First Queue");
  lines.push("");
  lines.push("| Rank | Target | Kind | Surface | TVL/APY | Chains | Coverage | Why Next |");
  lines.push("|---:|---|---|---|---:|---|---|---|");
  for (const row of artifact.rankedQueue.slice(0, 15)) {
    const tvlApy = row.kind === "yield" ? `${formatUsd(row.tvlUsd)} / ${row.apyPct}%` : formatUsd(row.tvlUsd);
    const chains = row.kind === "yield" ? row.chain : (row.accessibleEvmChains || []).slice(0, 4).join(", ");
    const why = row.kind === "yield" ? `${row.symbol || "yield pool"}; ${row.routeGraph}` : `${row.category || "protocol"}; ${row.routeGraph}`;
    lines.push(`| ${row.rank} | ${safe(rowLabel(row), 64)} | ${row.kind} | ${row.surface} | ${tvlApy} | ${safe(chains || "n/a", 80)} | ${row.coverage.state} | ${safe(why, 150)} |`);
  }
  lines.push("");
  lines.push("## First Checks For The Top 5");
  lines.push("");
  for (const row of artifact.rankedQueue.slice(0, 5)) {
    lines.push(`### ${row.rank}. ${safe(rowLabel(row), 90)}`);
    lines.push("");
    lines.push(`Surface: \`${row.surface}\``);
    lines.push("");
    lines.push(`Route graph: ${safe(row.routeGraph, 180)}`);
    lines.push("");
    for (const check of row.firstReadOnlyChecks || []) lines.push(`- ${safe(check, 140)}`);
    if (row.adapter) lines.push(`- Adapter hint: ${row.adapter.adapterFetched ? `${row.adapter.adapterAddressCount} addresses, ${row.adapter.adapterHints.join(", ") || "no selector hints"}` : "adapter source not fetched"}`);
    lines.push("");
  }
  lines.push("## Non-EVM / Blocked Coverage Watchlist");
  lines.push("");
  lines.push("These are not route-negative closures. They need chain-specific non-EVM tooling, endpoints, or source coverage before they can be closed or promoted.");
  lines.push("");
  lines.push("| Target | Category | TVL | Caveat Chains | Next Step |");
  lines.push("|---|---|---:|---|---|");
  for (const row of artifact.blockedCoverage.slice(0, 10)) {
    const caveatChains = (row.blockedOrCaveatChains || []).length ? row.blockedOrCaveatChains : (row.accessibleNonEvmChains || []);
    lines.push(`| ${safe(row.name || row.slug, 64)} | ${safe(row.category || "n/a", 40)} | ${formatUsd(row.tvlUsd)} | ${safe(caveatChains.slice(0, 6).join(", ") || "n/a", 90)} | ${safe((row.firstReadOnlyChecks || [])[0] || "map endpoints and deployments", 120)} |`);
  }
  lines.push("");
  lines.push("## Gate");
  lines.push("");
  lines.push("Fork work remains closed until a candidate has an exact deployed producer anomaly or proof/accounting bypass, a joined live consumer with material borrow/redeem/liquidation/unlock liquidity, and positive read-only economics after fees, slippage, caps, queues, and gas.");
  lines.push("");
  lines.push("No signed action, fork proof, executor work, or live transaction is justified from this target-search artifact alone.");
  fs.writeFileSync(OUT_MD, lines.join("\n") + "\n");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
