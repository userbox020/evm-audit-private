#!/usr/bin/env node
// discover-current-profit-leads.js — public read-only lead finder for current-profit research.
// Uses DeFiLlama public APIs only. No RPC inventory, no signed actions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "current-profit-leads.json");

const EVM_CHAINS = new Set(["Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "BSC", "Binance", "Hyperliquid L1", "Sonic", "Mantle", "Berachain"]);
const TARGET_CATEGORIES = new Set(["Lending", "Yield", "CDP", "Dexs", "Derivatives", "RWA", "RWA Lending", "Basis Trading", "Liquid Staking"]);

const EVALUATOR_MAP = [
  { re: /lorenzo/i, evaluator: "LOR", route: "sUSD1+ NAV/DEX premium" },
  { re: /hyperlend|hyperliquid/i, evaluator: "E17", route: "HyperEVM stale source / lending route" },
  { re: /morpho/i, evaluator: "E12x/E2/E9", route: "Morpho market/oracle/liquidation routes" },
  { re: /venus/i, evaluator: "VB/E14", route: "Venus isolated oracle/unpause routes" },
  { re: /aave/i, evaluator: "E10/E18", route: "Aave cross-chain oracle/flash-fee routes" },
  { re: /fluid/i, evaluator: "E8/E5", route: "Fluid stale/depeg routes" },
  { re: /compound/i, evaluator: "E1/E14", route: "Compound stale/CAPO/unpause routes" },
  { re: /silo/i, evaluator: "manual", route: "Silo stale feed/liquidity routes" },
  { re: /gearbox/i, evaluator: "manual", route: "stale-source/lending routes" },
  { re: /pendle|curve|convex|stake-dao|penpie/i, evaluator: "research", route: "yield/share-price/market dislocation" },
];

async function fetchJson(url, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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

function mapEvaluator(text) {
  for (const item of EVALUATOR_MAP) {
    if (item.re.test(text)) return { evaluator: item.evaluator, route: item.route };
  }
  return { evaluator: "research", route: "new source/live config review" };
}

function chainScore(chain) {
  return EVM_CHAINS.has(chain) ? 8 : chain === "Solana" ? 4 : 1;
}

function stableYieldLeads(yields) {
  return (yields?.data || [])
    .filter((p) => (p.tvlUsd || 0) >= 500_000)
    .filter((p) => EVM_CHAINS.has(p.chain))
    .filter((p) => p.stablecoin === true && p.ilRisk === "no")
    .filter((p) => (p.apy || 0) >= 15)
    .map((p) => {
      const mapped = mapEvaluator(`${p.project} ${p.symbol}`);
      const apyScore = clamp((p.apy || 0) / 100, 0, 1) * 30;
      const tvlScore = clamp(Math.log10(Math.max(1, p.tvlUsd || 0)) / 8, 0, 1) * 15;
      return {
        type: "stable-yield-anomaly",
        project: p.project,
        chain: p.chain,
        symbol: p.symbol,
        tvlUsd: round(p.tvlUsd, 0),
        apyPct: round(p.apy, 2),
        apyBasePct: round(p.apyBase, 2),
        pool: p.pool,
        underlying: Array.isArray(p.underlyingTokens) ? p.underlyingTokens.slice(0, 4) : [],
        evaluator: mapped.evaluator,
        candidateRoute: mapped.route,
        score: Math.round(45 + apyScore + tvlScore + chainScore(p.chain)),
        firstReadOnlyChecks: ["resolve pool/vault contract", "compare share/NAV price to DEX price", "check mint/redeem/queue/liquidity", "fork-proof only if a route is positive"],
      };
    });
}

function evaluatorAdjacentYieldLeads(yields) {
  return (yields?.data || [])
    .filter((p) => (p.tvlUsd || 0) >= 100_000)
    .filter((p) => (p.apy || 0) >= 5)
    .filter((p) => /morpho|venus|hyperlend|lorenzo|aave|compound|fluid|silo|gearbox/i.test(`${p.project} ${p.symbol}`))
    .map((p) => {
      const mapped = mapEvaluator(`${p.project} ${p.symbol}`);
      return {
        type: "evaluator-adjacent-yield",
        project: p.project,
        chain: p.chain,
        symbol: p.symbol,
        tvlUsd: round(p.tvlUsd, 0),
        apyPct: round(p.apy, 2),
        apyBasePct: round(p.apyBase, 2),
        stablecoin: p.stablecoin,
        ilRisk: p.ilRisk,
        pool: p.pool,
        underlying: Array.isArray(p.underlyingTokens) ? p.underlyingTokens.slice(0, 4) : [],
        evaluator: mapped.evaluator,
        candidateRoute: mapped.route,
        score: Math.round(35 + clamp((p.apy || 0) / 75, 0, 1) * 25 + clamp(Math.log10(Math.max(1, p.tvlUsd || 0)) / 8, 0, 1) * 15 + chainScore(p.chain)),
        firstReadOnlyChecks: ["map exact market/vault", "check oracle/source freshness", "check borrower/liquidity/caps", "quote route and gas"],
      };
    });
}

function growthLeads(protocols) {
  return (protocols || [])
    .filter((p) => (p.tvl || 0) >= 5_000_000)
    .filter((p) => TARGET_CATEGORIES.has(p.category))
    .filter((p) => (p.chains || []).some((c) => EVM_CHAINS.has(c)))
    .filter((p) => (p.change_1d || 0) >= 5 || (p.change_7d || 0) >= 30)
    .map((p) => {
      const mapped = mapEvaluator(`${p.name} ${p.slug} ${p.category}`);
      const bestChain = (p.chains || []).find((c) => EVM_CHAINS.has(c)) || p.chains?.[0] || null;
      return {
        type: "protocol-growth-anomaly",
        name: p.name,
        slug: p.slug,
        category: p.category,
        tvlUsd: round(p.tvl, 0),
        change1dPct: round(p.change_1d, 2),
        change7dPct: round(p.change_7d, 2),
        chains: (p.chains || []).slice(0, 10),
        evaluator: mapped.evaluator,
        candidateRoute: mapped.route,
        score: Math.round(25 + clamp((p.change_7d || 0) / 100, 0, 1) * 30 + clamp((p.change_1d || 0) / 20, 0, 1) * 20 + clamp(Math.log10(Math.max(1, p.tvl || 0)) / 9, 0, 1) * 15 + chainScore(bestChain)),
        firstReadOnlyChecks: ["resolve deployments", "map proxy/implementation and roles", "query live oracles/caps/pauses", "rank concrete invariant breaks"],
      };
    });
}

function pegStressLeads(stables) {
  const rows = Array.isArray(stables?.peggedAssets) ? stables.peggedAssets : [];
  return rows
    .map((s) => {
      const price = Number(s.price || s.geckoPrice || s.priceSource || 0);
      const pegType = s.pegType || s.pegMechanism || "unknown";
      const deviationPct = price > 0 ? Math.abs(price - 1) * 100 : 0;
      return { s, price, pegType, deviationPct };
    })
    .filter(({ deviationPct }) => deviationPct >= 0.2)
    .filter(({ s }) => (s.circulating || s.circulatingPrevDay || 0) >= 1_000_000 || (s.mcap || 0) >= 1_000_000)
    .map(({ s, price, pegType, deviationPct }) => {
      const mapped = mapEvaluator(`${s.name} ${s.symbol || ""} ${pegType}`);
      return {
        type: "peg-stress",
        name: s.name,
        symbol: s.symbol,
        price: round(price, 6),
        deviationPct: round(deviationPct, 3),
        pegType,
        mcapUsd: round(s.mcap || s.circulating || s.circulatingPrevDay, 0),
        chains: Object.keys(s.chainCirculating || {}).slice(0, 10),
        evaluator: mapped.evaluator === "research" ? "E5/research" : mapped.evaluator,
        candidateRoute: mapped.evaluator === "research" ? "depeg borrow/redeem/liquidity route" : mapped.route,
        score: Math.round(30 + clamp(deviationPct / 5, 0, 1) * 35 + clamp(Math.log10(Math.max(1, s.mcap || s.circulating || 0)) / 9, 0, 1) * 15),
        firstReadOnlyChecks: ["verify live oracle/feed price", "check redeem/mint path", "check lending collateral/borrow caps", "quote DEX route"],
      };
    });
}

function uniqueLeads(leads) {
  const seen = new Set();
  const out = [];
  for (const lead of leads.sort((a, b) => b.score - a.score)) {
    const key = `${lead.type}:${lead.project || lead.name}:${lead.chain || ""}:${lead.symbol || lead.slug || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lead);
  }
  return out;
}

async function main() {
  const [protocols, yields, stables] = await Promise.all([
    fetchJson("https://api.llama.fi/protocols", 30_000),
    fetchJson("https://yields.llama.fi/pools", 45_000),
    fetchJson("https://stablecoins.llama.fi/stablecoins?includePrices=true", 45_000),
  ]);

  const categories = {
    stableYieldAnomalies: stableYieldLeads(yields).sort((a, b) => b.score - a.score).slice(0, 40),
    evaluatorAdjacentYield: evaluatorAdjacentYieldLeads(yields).sort((a, b) => b.score - a.score).slice(0, 50),
    protocolGrowth: growthLeads(Array.isArray(protocols) ? protocols : []).sort((a, b) => b.score - a.score).slice(0, 40),
    pegStress: pegStressLeads(stables).sort((a, b) => b.score - a.score).slice(0, 40),
  };
  const combined = uniqueLeads([
    ...categories.stableYieldAnomalies,
    ...categories.evaluatorAdjacentYield,
    ...categories.protocolGrowth,
    ...categories.pegStress,
  ]).slice(0, 80);

  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Public read-only current-profit lead discovery",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
    },
    sources: [
      "https://api.llama.fi/protocols",
      "https://yields.llama.fi/pools",
      "https://stablecoins.llama.fi/stablecoins?includePrices=true",
    ],
    sourceStatus: {
      protocolsAvailable: Array.isArray(protocols),
      yieldsAvailable: Boolean(yields?.data),
      stablecoinsAvailable: Boolean(stables?.peggedAssets),
    },
    summary: {
      totalCombinedLeads: combined.length,
      stableYieldAnomalies: categories.stableYieldAnomalies.length,
      evaluatorAdjacentYield: categories.evaluatorAdjacentYield.length,
      protocolGrowth: categories.protocolGrowth.length,
      pegStress: categories.pegStress.length,
      topLead: combined[0] || null,
    },
    combined,
    categories,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

  console.log(`Wrote ${path.relative(WORKSPACE, OUT)}`);
  console.log(`Combined leads=${combined.length}; stableYield=${categories.stableYieldAnomalies.length}; evaluatorAdjacent=${categories.evaluatorAdjacentYield.length}; growth=${categories.protocolGrowth.length}; pegStress=${categories.pegStress.length}`);
  for (const [i, lead] of combined.slice(0, 10).entries()) {
    const label = lead.project || lead.name || lead.symbol || lead.slug;
    const metric = lead.apyPct !== undefined ? `apy=${lead.apyPct}%` : lead.change7dPct !== undefined ? `7d=${lead.change7dPct}%` : lead.deviationPct !== undefined ? `depeg=${lead.deviationPct}%` : "";
    console.log(`#${i + 1} ${lead.type} ${label} ${lead.chain || ""} ${lead.symbol || lead.slug || ""} score=${lead.score} ${metric} evaluator=${lead.evaluator}`.trim());
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
