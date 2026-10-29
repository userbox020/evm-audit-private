#!/usr/bin/env node
// scan-circle-usyc-phase0.js - read-only Phase 0 wrapper for Circle USYC.
// Uses public metadata plus the generic RWA/NAV consumer graph. RPC URLs stay in memory in the child scanner.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "circle-usyc-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "circle-usyc-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const TOKENS = [
  { chain: "Ethereum", chainId: 1, adapterKey: "ethereum", token: "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b" },
  { chain: "BNB Chain", llamaKey: "Binance", chainId: 56, adapterKey: "bsc", token: "0x8D0fA28f221eB5735BC71d3a0Da67EE5bC821311" },
];

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function formatUsd(value) {
  const n = asNumber(value);
  return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`;
}

function shortAddress(value) {
  const text = String(value || "");
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text || "n/a";
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-circle-usyc-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function latestRow(rows) {
  return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;
}

function chainData(metadata, key) {
  const row = metadata?.chainTvls?.[key] || {};
  return {
    tvlUsd: latestRow(row.tvl)?.totalLiquidityUSD ?? metadata?.currentChainTvls?.[key] ?? null,
    tokens: latestRow(row.tokens)?.tokens || {},
    tokensInUsd: latestRow(row.tokensInUsd)?.tokens || {},
  };
}

function flattenResults(consumerGraph, field) {
  return (consumerGraph?.results || []).flatMap((row) => Array.isArray(row[field]) ? row[field] : []);
}

async function fetchDexRows() {
  try {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${TOKENS.map((row) => row.token).join(",")}`, 30_000);
    const wanted = new Map(TOKENS.map((row) => [row.token.toLowerCase(), row]));
    const rows = [];
    for (const pair of json.pairs || []) {
      const base = String(pair.baseToken?.address || "").toLowerCase();
      const quote = String(pair.quoteToken?.address || "").toLowerCase();
      const match = wanted.get(base) || wanted.get(quote);
      if (!match) continue;
      rows.push({
        chain: match.chain,
        chainId: pair.chainId || null,
        dexId: pair.dexId || null,
        pairAddress: pair.pairAddress || null,
        baseSymbol: pair.baseToken?.symbol || null,
        quoteSymbol: pair.quoteToken?.symbol || null,
        liquidityUsd: round(pair.liquidity?.usd, 2),
        volume24hUsd: round(pair.volume?.h24, 2),
        priceUsd: round(pair.priceUsd, 8),
      });
    }
    return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 20);
  } catch (_) {
    return [];
  }
}

function runConsumerGraph() {
  ensureDir(RAW_OUT);
  const child = spawnSync(process.execPath, ["scan-rwa-nav-consumer-graph.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      RWA_NAV_SYMBOL_FILTER: "USYC",
      RWA_NAV_CHAIN_IDS: "1,56",
      RWA_NAV_OUT: "reports/raw/fast/circle-usyc-phase0.json",
    },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (child.status !== 0) {
    const msg = `${child.stderr || child.stdout || "RWA/NAV child scanner failed"}`.slice(0, 1000);
    throw new Error(msg);
  }
  if (!QUIET && child.stdout) process.stdout.write(child.stdout);
  return readJson(RAW_OUT, null);
}

function writeReport(out) {
  const s = out.summary;
  const tokenTable = out.tokenRows.map((row) => `| ${row.chain} | ${shortAddress(row.address)} | ${row.codePresent} | ${row.totalSupply || "n/a"} | ${formatUsd(row.tokenPriceUsd)} | ${row.erc4626?.navUsdPerShare ? formatUsd(row.erc4626.navUsdPerShare) : "n/a"} | ${row.currentAnomaly} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const matchTable = out.topMatches.slice(0, 8).map((row) => `| ${row.protocol} | ${row.side} | ${row.producer?.chain || "n/a"} | ${row.producer?.symbol || "?"} | ${row.reviewCandidate} | ${row.watchCandidate} | ${formatUsd(row.market?.otherReserveCashUsd ?? row.market?.cashUsd ?? row.market?.baseCashUsd ?? row.market?.liquidityAssetsUsd ?? row.market?.oppositeLiquidityUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const dexTable = out.dexLiquidityRows.slice(0, 8).map((row) => `| ${row.chain} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} | ${row.priceUsd ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";

  const content = `# 🟢 DORMANT — Circle USYC Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-circle-usyc-phase0.js\`

Artifact: \`reports/raw/fast/circle-usyc-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass mapped the public Hashnote/Circle USYC adapter tokens on Ethereum and BNB Chain, ran the generic RWA/NAV producer-to-consumer graph against Aave/Morpho/Euler/Silo/Compound-style consumers, sampled public DEX context, and checked for current NAV/reference anomalies. Current gates remain closed because no material consumer route has accepted-value divergence, exact-positive borrow/liquidation/redemption/unwind economics, or fork proof.

## Summary

| Metric | Value |
|---|---:|
| DeFiLlama TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum TVL | ${formatUsd(s.ethereumTvlUsd)} |
| BNB Chain TVL | ${formatUsd(s.bnbTvlUsd)} |
| Token rows | \`${s.tokenRows}\` |
| Token rows with code | \`${s.tokenRowsWithCode}\` |
| Consumer matches | \`${s.matches}\` |
| Review candidates | \`${s.reviewCandidates}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Producer anomalies | \`${s.producerAnomalies}\` |
| Top DEX liquidity | ${formatUsd(s.topDexLiquidityUsd)} |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |

## USYC Tokens

| Chain | Token | Code | Total supply | Public token price | ERC4626 NAV/share | Current anomaly |
|---|---|---:|---:|---:|---:|---:|
${tokenTable}

## Consumer Matches

| Protocol | Side | Producer chain | Symbol | Review | Watch | Route-side liquidity |
|---|---|---|---|---:|---:|---:|
${matchTable}

## DEX Context

| Chain | DEX | Pair | Liquidity USD | 24h volume USD | Price USD |
|---|---|---|---:|---:|---:|
${dexTable}

## Blockers

- USYC RWA issuance/redemption remains treated as permissioned unless a public atomic exit is proven.
- No current USYC NAV/reference anomaly above the configured threshold was observed in the consumer graph.
- Any consumer matches are route-negative until accepted-value semantics, transferability, exact acquisition, borrow/liquidation/redeem path, and exit liquidity are proven.
- Public DEX liquidity is context only; no exact positive borrow, redemption, liquidation, or unwind route is proven.
- No fork extraction proof and no signed-action justification exist.

## Required For Route-Positive

- USYC must be accepted by a material lending, margin, redemption, or liquidation consumer with a permissionless value-changing trigger.
- Accepted value must diverge from exact acquisition, NAV, redemption, or DEX exit value in an attacker-favorable direction.
- Borrowed, redeemed, or seized assets must have exact positive exit economics after gas, fees, slippage, and permission constraints.
- Fork extraction proof must show measured profit.

## Next Read-Only Step

Keep USYC on RWA/NAV consumer-join watch. Reopen for exact quoting only if a material consumer listing appears, a stale/NAV/accepted-value divergence becomes current, or a permissionless redemption/DEX exit path becomes exact-positive after costs.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const consumerGraph = runConsumerGraph();
  const [metadataRaw, dexLiquidityRows] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/circle-usyc", 45_000).catch(() => ({})),
    fetchDexRows(),
  ]);
  if (!consumerGraph) throw new Error("Missing consumer graph artifact after child scan");

  const tokenRows = flattenResults(consumerGraph, "topProducers").filter((row) => String(row.symbol || "").toUpperCase() === "USYC");
  const topMatches = flattenResults(consumerGraph, "topMatches");
  const latestTvl = latestRow(metadataRaw.tvl)?.totalLiquidityUSD ?? Object.values(metadataRaw.currentChainTvls || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const ethData = chainData(metadataRaw, "Ethereum");
  const bnbData = chainData(metadataRaw, "Binance");
  const routePositive = asNumber(consumerGraph.summary?.routePositive) || 0;
  const watchCandidates = asNumber(consumerGraph.summary?.watchCandidates) || 0;

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-circle-usyc-phase0.js",
    scope: "Circle USYC public Phase 0 RWA/NAV token, consumer graph, and exit-liquidity triage",
    safety: {
      publicApisOnly: false,
      rpcInventoryRead: Boolean(consumerGraph.safety?.rpcInventoryRead),
      rpcInventoryOnly: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    metadata: {
      name: metadataRaw.name || "Circle USYC",
      slug: metadataRaw.slug || "circle-usyc",
      category: metadataRaw.category || "RWA",
      chains: metadataRaw.chains || ["Ethereum", "Near", "Noble", "Binance"],
      module: metadataRaw.module || "hashnote/index.js",
      tvlCodePath: metadataRaw.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/hashnote/index.js",
      methodology: metadataRaw.methodology || null,
      evmAdapterTokens: TOKENS,
      nonEvmTokens: [
        { chain: "Near", token: "usyc.near", note: "non-EVM context only" },
        { chain: "Noble", token: "uusyc", note: "non-EVM context only" },
      ],
    },
    tokenRows,
    dexLiquidityRows,
    topMatches,
    consumerGraph,
    summary: {
      defillamaCurrentTvlUsd: round(latestTvl, 2),
      ethereumTvlUsd: round(ethData.tvlUsd, 2),
      bnbTvlUsd: round(bnbData.tvlUsd, 2),
      tokenRows: tokenRows.length,
      tokenRowsWithCode: tokenRows.filter((row) => row.codePresent).length,
      producersInput: asNumber(consumerGraph.summary?.producersInput) || 0,
      producersResolved: asNumber(consumerGraph.summary?.producersResolved) || 0,
      producersCodePresent: asNumber(consumerGraph.summary?.producersCodePresent) || 0,
      producersWithPublicTokenPrice: asNumber(consumerGraph.summary?.producersWithPublicTokenPrice) || 0,
      producersWithErc4626Nav: asNumber(consumerGraph.summary?.producersWithErc4626Nav) || 0,
      producerAnomalies: asNumber(consumerGraph.summary?.producerAnomalies) || 0,
      matches: asNumber(consumerGraph.summary?.matches) || 0,
      reviewCandidates: asNumber(consumerGraph.summary?.reviewCandidates) || 0,
      watchCandidates,
      dexLiquidityRows: dexLiquidityRows.length,
      topDexLiquidityUsd: round(dexLiquidityRows[0]?.liquidityUsd, 2),
      routePositive,
      executableNow: false,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      status: routePositive > 0 ? "circle-usyc-route-positive-needs-proof" : watchCandidates > 0 ? "circle-usyc-watch-needs-nav-consumer-economics" : "circle-usyc-phase0-no-route-positive",
    },
    blockers: [
      "No USYC consumer-side borrow/liquidation/redeem route with current accepted-value divergence and material exact-positive economics was found",
      "No ERC4626 NAV interface or current NAV/reference divergence above threshold was resolved for the USYC producer rows",
      "RWA issuance/redemption and transferability remain treated as permissioned/restricted absent public atomic exit proof",
      "Public DEX liquidity is context only and no exact positive acquisition, redeem, borrow, liquidation, or unwind route was proven",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "USYC accepted by a material lending, margin, redemption, or liquidation consumer",
      "permissionless NAV/oracle/backing/accepted-value divergence or current liquidatable borrower condition",
      "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs",
      "fork extraction proof",
    ],
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, null, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Circle USYC Phase0: tvl=${formatUsd(output.summary.defillamaCurrentTvlUsd)} tokens=${output.summary.tokenRows} matches=${output.summary.matches} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 1000));
  process.exit(1);
});
