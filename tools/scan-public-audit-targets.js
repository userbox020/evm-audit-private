#!/usr/bin/env node
// scan-public-audit-targets.js - public read-only target discovery for EVM audit sprints.
// Uses public DeFiLlama APIs and local sanitized report coverage only. No RPC, env, keys, or signed actions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "public-audit-target-discovery-triage.md");
const REPORTS_DIR = path.join(WORKSPACE, "reports");

const QUIET = process.argv.includes("--quiet");
const MIN_TVL_USD = Number(process.env.PUBLIC_AUDIT_TARGET_MIN_TVL_USD || "5000000");
const MAX_PROTOCOLS = Number(process.env.PUBLIC_AUDIT_TARGET_MAX_PROTOCOLS || "80");
const MAX_YIELDS = Number(process.env.PUBLIC_AUDIT_TARGET_MAX_YIELDS || "80");

const EVM_CHAINS = new Set([
  "Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "BSC", "Binance",
  "Sonic", "Mantle", "Berachain", "Gnosis", "Linea", "Scroll", "Celo", "Blast", "World Chain", "Ink",
]);
const CUSTOM_SUPPORTED_CHAINS = new Set(["Hyperliquid L1"]);
const TARGET_CATEGORIES = new Set([
  "Lending", "Yield", "CDP", "Dexs", "Derivatives", "RWA", "RWA Lending", "Basis Trading",
  "Liquid Staking", "Bridge", "Canonical Bridge",
]);

const COVERAGE_HINTS = [
  { re: /aave/i, reports: ["aave-v3-route-distance-triage.md", "aave-v4-hubs-triage.md"], state: "covered-hot-watch" },
  { re: /morpho/i, reports: ["morpho-high-apy-liquidation-routes-triage.md", "morpho-liquidatable-marketability-triage.md"], state: "covered-watch" },
  { re: /hyperlend|hyperliquid|sthype|khype|kinetiq/i, reports: ["hyperlend-triage.md", "hyperliquid-linked-token-consumers-triage.md", "hyperevm-lst-lrt-oracle-routes-triage.md"], state: "covered-watch" },
  { re: /dolomite/i, reports: ["dolomite-berachain-triage.md", "post-audit-deployed-map-triage.md"], state: "covered-needs-focused-recheck" },
  { re: /uniswap v4|uniswap-v4/i, reports: ["uniswap-v4-hooks-triage.md", "fake-asset-pool-validation-triage.md"], state: "covered-clean-static" },
  { re: /layerzero/i, reports: ["layerzero-v2-triage.md", "layerzero-oft-dvn-consumer-joins-triage.md"], state: "covered-watch" },
  { re: /usdt0|usd0/i, reports: ["usdt0-consumer-routes-triage.md", "usdt0-oft-routes-triage.md"], state: "covered-watch" },
  { re: /spark/i, reports: ["spark-triage.md", "spark-crosschain-triage.md"], state: "covered-watch" },
  { re: /maple/i, reports: ["maple-triage.md"], state: "covered-watch" },
  { re: /pendle/i, reports: ["pendle-pt-multichain-consumer-graph-triage.md", "pendle-yt-collateral-routes-triage.md"], state: "covered-watch" },
  { re: /ondo/i, reports: ["ondo-finance-triage.md"], state: "covered-watch" },
  { re: /reserve/i, reports: ["reserve-protocol-triage.md"], state: "covered-watch" },
  { re: /yearn/i, reports: ["yearn-v3-triage.md"], state: "covered-watch" },
];

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeText(value, max = 160) {
  return String(value || "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max);
}

async function fetchJson(url, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-target-discovery/1.0" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function localReportExists(name) {
  return fs.existsSync(path.join(WORKSPACE, "reports", name));
}

let reportNameCache = null;
function localReportNames() {
  if (reportNameCache) return reportNameCache;
  try {
    reportNameCache = fs.readdirSync(REPORTS_DIR).filter((name) => name.endsWith(".md"));
  } catch (_) {
    reportNameCache = [];
  }
  return reportNameCache;
}

function slugKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const COVERAGE_ALIASES = {
  "40-acres": ["40acres"],
  "alpaca-finance-2-0": ["alpaca-finance-2"],
  "apollo-diversified-credit-securitize-fund": ["apollo-acred", "acred"],
  "centrifuge-protocol": ["centrifuge"],
  "etherfi-borrowing-market": ["etherfi-borrowing", "etherfi-cash"],
  "harmonix-finance": ["harmonix"],
  "reservoir-protocol": ["reservoir"],
};

function inferredCoverageReports(keys) {
  const base = (keys || []).map(slugKey).filter((key) => key.length >= 2);
  const wanted = [...new Set(base.flatMap((key) => [key, ...(COVERAGE_ALIASES[key] || [])]))];
  if (!wanted.length) return [];
  const names = localReportNames();
  const matched = [];
  for (const key of wanted) {
    for (const name of names) {
      const lower = name.toLowerCase();
      if (lower === `${key}.md` || lower.startsWith(`${key}-`)) matched.push(name);
    }
  }
  return [...new Set(matched)].slice(0, 6);
}

function coverageFor(text, keys = []) {
  const matched = [];
  for (const hint of COVERAGE_HINTS) {
    if (!hint.re.test(text)) continue;
    matched.push({
      state: hint.state,
      reports: hint.reports.filter(localReportExists),
    });
  }
  const inferred = inferredCoverageReports(keys);
  if (inferred.length) matched.push({ state: "covered-watch", reports: inferred });
  if (!matched.length) return { state: "fresh-or-uncovered", reports: [], penalty: 0 };
  const reports = [...new Set(matched.flatMap((row) => row.reports))];
  const severe = matched.find((row) => /covered-hot-watch|covered-watch/.test(row.state)) || matched[0];
  return { state: severe.state, reports, penalty: severe.state === "covered-clean-static" ? 18 : severe.state === "covered-hot-watch" ? 12 : 8 };
}

function surfaceFor(text, category) {
  const t = `${text} ${category}`.toLowerCase();
  if (/bridge|oft|warp|layerzero|wormhole|hyperlane/.test(t)) return "bridge-proof-custody-consumer";
  if (/lending|lend|borrow|cdp|credit/.test(t)) return "lending-oracle-liquidation";
  if (/rwa|treasury|credit|matrixdock|frax usd|ustb|gold|securitize/.test(t)) return "rwa-nav-oracle-consumer";
  if (/liquid staking|lst|lrt|hype|staked|staking/.test(t)) return "lst-lrt-rate-consumer";
  if (/yield|vault|royco|allocator/.test(t)) return "vault-yield-allocator";
  if (/dex|clmm|slipstream|uniswap|aerodrome|blackhole|ramses/.test(t)) return "dex-oracle-consumer-only";
  return "general-evm-review";
}

function auditFit(surface) {
  switch (surface) {
    case "lending-oracle-liquidation": return 28;
    case "rwa-nav-oracle-consumer": return 24;
    case "bridge-proof-custody-consumer": return 22;
    case "vault-yield-allocator": return 20;
    case "lst-lrt-rate-consumer": return 18;
    case "dex-oracle-consumer-only": return 10;
    default: return 12;
  }
}

function chainSupport(chains) {
  const list = Array.isArray(chains) ? chains : [chains].filter(Boolean);
  const evm = list.filter((chain) => EVM_CHAINS.has(chain));
  const custom = list.filter((chain) => CUSTOM_SUPPORTED_CHAINS.has(chain));
  return {
    evmChains: evm,
    customSupportedChains: custom,
    supported: evm.length > 0 || custom.length > 0,
    primary: evm[0] || custom[0] || list[0] || null,
  };
}

function firstChecks(surface) {
  const common = ["resolve source and deployed addresses", "map proxies/admin/roles", "join token/oracle to consumers", "fork only after route-positive economics"];
  if (surface === "lending-oracle-liquidation") return ["map pools/markets and oracles", "query caps/pauses/borrow cash", "rank near-liquidation and oracle divergence", "quote exact liquidation/borrow routes only after trigger"];
  if (surface === "rwa-nav-oracle-consumer") return ["resolve token, NAV oracle, and redemption path", "join token to lending/PT/vault consumers", "compare accepted value vs redeem/DEX value", "check queues, permissions, and exact exits"];
  if (surface === "bridge-proof-custody-consumer") return ["map bridge contracts, escrows, and wrapped tokens", "check proof/domain/nonce/token binding", "join wrapped assets to lending/DEX consumers", "look for backing or balance-delta mismatch"];
  if (surface === "vault-yield-allocator") return ["resolve vault/share token and allocator", "check ERC4626/share-rate/donation semantics", "map withdrawal queues and caps", "join shares to borrow/redeem/liquidation consumers"];
  if (surface === "dex-oracle-consumer-only") return ["do not audit APY alone", "join token/LP/pool to lending oracle consumers", "check TWAP/depth/manipulation cost", "fork only if consumer route is positive"];
  return common;
}

function protocolCandidates(protocols) {
  return (protocols || [])
    .filter((p) => (p.tvl || 0) >= MIN_TVL_USD)
    .filter((p) => TARGET_CATEGORIES.has(p.category))
    .filter((p) => chainSupport(p.chains || []).supported)
    .map((p) => {
      const text = `${p.name} ${p.slug} ${p.category}`;
      const support = chainSupport(p.chains || []);
      const surface = surfaceFor(text, p.category);
      const coverage = coverageFor(text, [p.slug, p.name]);
      const growthScore = clamp(Math.max(0, p.change_7d || 0) / 100, 0, 3) * 30 + clamp(Math.max(0, p.change_1d || 0) / 30, 0, 2) * 18;
      const tvlScore = clamp(Math.log10(Math.max(1, p.tvl || 0)) / 10, 0, 1) * 30;
      const freshBonus = coverage.state === "fresh-or-uncovered" ? 18 : 0;
      const score = tvlScore + growthScore + auditFit(surface) + freshBonus - coverage.penalty;
      return {
        kind: "protocol",
        name: p.name,
        slug: p.slug,
        category: p.category,
        surface,
        tvlUsd: round(p.tvl, 0),
        change1dPct: round(p.change_1d, 2),
        change7dPct: round(p.change_7d, 2),
        chains: (p.chains || []).slice(0, 12),
        primaryChain: support.primary,
        evmChains: support.evmChains,
        customSupportedChains: support.customSupportedChains,
        coverage,
        score: round(score, 1),
        firstReadOnlyChecks: firstChecks(surface),
      };
    })
    .sort((a, b) => b.score - a.score);
}

function yieldCandidates(yields) {
  return (yields?.data || [])
    .filter((p) => (p.tvlUsd || 0) >= 200_000)
    .filter((p) => (p.apy || 0) >= 20)
    .filter((p) => chainSupport([p.chain]).supported)
    .map((p) => {
      const text = `${p.project} ${p.symbol}`;
      const surface = surfaceFor(text, "Yield");
      const coverage = coverageFor(text, [p.project, p.symbol]);
      const apyScore = p.apy > 1000 ? 34 : p.apy > 100 ? 22 : p.apy > 40 ? 12 : 6;
      const tvlScore = clamp(Math.log10(Math.max(1, p.tvlUsd || 0)) / 9, 0, 1) * 22;
      const consumerPenalty = surface === "dex-oracle-consumer-only" ? 12 : 0;
      const score = tvlScore + apyScore + auditFit(surface) - coverage.penalty - consumerPenalty;
      return {
        kind: "yield",
        project: p.project,
        chain: p.chain,
        symbol: p.symbol,
        surface,
        tvlUsd: round(p.tvlUsd, 0),
        apyPct: round(p.apy, 2),
        apyBasePct: round(p.apyBase, 2),
        stablecoin: p.stablecoin,
        ilRisk: p.ilRisk,
        pool: p.pool,
        underlying: Array.isArray(p.underlyingTokens) ? p.underlyingTokens.slice(0, 4) : [],
        coverage,
        score: round(score, 1),
        firstReadOnlyChecks: firstChecks(surface),
      };
    })
    .sort((a, b) => b.score - a.score);
}

function routePriority(row) {
  if (row.surface === "dex-oracle-consumer-only") return "consumer-join-first";
  if (row.coverage.state !== "fresh-or-uncovered") return "targeted-refresh";
  return "phase0-now";
}

function combinedRows(protocols, yields) {
  const rows = [...protocols, ...yields].map((row) => ({ ...row, routePriority: routePriority(row) }));
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

function mdTable(rows) {
  const lines = ["| Rank | Target | Surface | Chain(s) | Signal | Coverage | Next step |", "|---:|---|---|---|---:|---|---|"];
  rows.slice(0, 15).forEach((row, i) => {
    const target = row.kind === "protocol" ? `${row.name} (${row.slug})` : `${row.project} ${row.symbol}`;
    const chains = row.kind === "protocol" ? (row.evmChains.concat(row.customSupportedChains).slice(0, 4).join("/") || row.primaryChain || "n/a") : row.chain;
    const signal = row.kind === "protocol" ? `$${row.tvlUsd?.toLocaleString?.() || row.tvlUsd}, 7d ${row.change7dPct ?? "n/a"}%` : `$${row.tvlUsd?.toLocaleString?.() || row.tvlUsd}, APY ${row.apyPct}%`;
    const coverage = row.coverage.state === "fresh-or-uncovered" ? "fresh" : `${row.coverage.state} (${row.coverage.reports.slice(0, 2).join(", ")})`;
    lines.push(`| ${i + 1} | \`${safeText(target, 60)}\` | ${row.surface} | ${safeText(chains, 60)} | ${safeText(signal, 60)} | ${safeText(coverage, 90)} | ${row.routePriority} |`);
  });
  return lines.join("\n");
}

function writeReport(out) {
  const phase0 = out.phase0Queue.slice(0, 8);
  const covered = out.targetedRefreshQueue.slice(0, 8);
  const consumer = out.consumerJoinFirst.slice(0, 8);
  const content = `# 🟢 DORMANT — Public EVM Audit Target Discovery

Generated: ${out.generatedAt}

Scanner: \`tools/scan-public-audit-targets.js\`

## Result

No permissionless route-positive exploit is claimed by this target-discovery pass. This is a Phase 0 queue for applying the \`evm-audit\` methodology to fresh or resurfacing targets.

## Summary

| Metric | Value |
|---|---:|
| Protocol candidates | \`${out.summary.protocolCandidates}\` |
| Yield candidates | \`${out.summary.yieldCandidates}\` |
| Phase 0 queue | \`${out.summary.phase0Queue}\` |
| Targeted refresh queue | \`${out.summary.targetedRefreshQueue}\` |
| Consumer-join-first rows | \`${out.summary.consumerJoinFirst}\` |
| Route-positive rows | \`0\` |
| Signed action justified | \`false\` |

## Phase 0 Queue

${mdTable(phase0)}

## Targeted Refresh Queue

${mdTable(covered)}

## Consumer-Join-First Queue

${mdTable(consumer)}

## Method

- Public protocol and yield data only: DeFiLlama \`/protocols\` and \`/pools\`.
- Local coverage was inferred from existing sanitized reports only.
- No RPC inventory, private keys, env files, calldata, fork transactions, or signed actions were used.

## Route-Positive Gate

Promote a target to fork work only after public target qualification maps a concrete deployed token/vault/bridge/market to borrow, liquidation, redemption, or DEX exit liquidity with exact positive read-only economics.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const [protocolsRaw, yieldsRaw] = await Promise.all([
    fetchJson("https://api.llama.fi/protocols", 30_000),
    fetchJson("https://yields.llama.fi/pools", 45_000),
  ]);
  const protocols = protocolCandidates(Array.isArray(protocolsRaw) ? protocolsRaw : []);
  const yields = yieldCandidates(yieldsRaw);
  const combined = combinedRows(protocols, yields);
  const phase0Queue = combined.filter((row) => row.routePriority === "phase0-now").slice(0, 50);
  const targetedRefreshQueue = combined.filter((row) => row.routePriority === "targeted-refresh").slice(0, 50);
  const consumerJoinFirst = combined.filter((row) => row.routePriority === "consumer-join-first").slice(0, 50);

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-public-audit-targets.js",
    scope: "Public read-only EVM audit target discovery and Phase 0 queueing",
    safety: {
      publicApisOnly: true,
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    sources: ["https://api.llama.fi/protocols", "https://yields.llama.fi/pools", "local sanitized reports/*.md"],
    thresholds: { minTvlUsd: MIN_TVL_USD, maxStoredProtocols: MAX_PROTOCOLS, maxStoredYields: MAX_YIELDS, queueLimit: 50 },
    summary: {
      protocolCandidates: protocols.length,
      yieldCandidates: yields.length,
      combinedCandidates: combined.length,
      storedProtocolCandidates: Math.min(protocols.length, MAX_PROTOCOLS),
      storedYieldCandidates: Math.min(yields.length, MAX_YIELDS),
      phase0Queue: phase0Queue.length,
      targetedRefreshQueue: targetedRefreshQueue.length,
      consumerJoinFirst: consumerJoinFirst.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      topPhase0Target: phase0Queue[0]?.name || phase0Queue[0]?.project || null,
      topTargetedRefresh: targetedRefreshQueue[0]?.name || targetedRefreshQueue[0]?.project || null,
    },
    phase0Queue,
    targetedRefreshQueue,
    consumerJoinFirst,
    topCombined: combined.slice(0, 50),
    protocolCandidates: protocols.slice(0, MAX_PROTOCOLS),
    yieldCandidates: yields.slice(0, MAX_YIELDS),
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(out, null, 2)}\n`);
  writeReport(out);

  if (!QUIET) {
    console.log(`Public audit target discovery: phase0=${phase0Queue.length} targetedRefresh=${targetedRefreshQueue.length} consumerJoinFirst=${consumerJoinFirst.length}`);
    console.log(`Top Phase0: ${phase0Queue[0]?.name || phase0Queue[0]?.project || "none"}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(safeText(err?.message || err, 240));
  process.exit(1);
});
