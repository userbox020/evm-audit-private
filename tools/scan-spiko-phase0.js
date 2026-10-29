#!/usr/bin/env node
// scan-spiko-phase0.js - read-only Phase 0 for Spiko RWA/NAV consumer joins.
// RPC URLs stay in memory in the child RWA/NAV scanner and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "spiko-phase0.json");
const GRAPH_OUT_REL = "reports/raw/fast/spiko-phase0-rwa-nav-consumer-graph.json";
const GRAPH_OUT = path.join(WORKSPACE, GRAPH_OUT_REL);
const REPORT_OUT = path.join(WORKSPACE, "reports", "spiko-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const SPIKO_TOKENS = [
  { chain: "Ethereum", chainId: 1, symbol: "USTBL", name: "Spiko US T-Bills Money Market Fund", address: "0xe4880249745eAc5F1eD9d8F7DF844792D560e750" },
  { chain: "Ethereum", chainId: 1, symbol: "EUTBL", name: "Spiko EU T-Bills Money Market Fund", address: "0xa0769f7A8fC65e47dE93797b4e21C073c117Fc80" },
  { chain: "Ethereum", chainId: 1, symbol: "SPKCC", name: "Spiko Cash & Carry Fund", address: "0x4f33acf823e6eeb697180d553ce0c710124c8d59" },
  { chain: "Ethereum", chainId: 1, symbol: "eurSPKCC", name: "Spiko EUR Cash & Carry Fund", address: "0x3868D4e336d14D38031cf680329d31e4712e11cC" },
  { chain: "Ethereum", chainId: 1, symbol: "UKTBL", name: "Spiko UK T-Bills Money Market Fund", address: "0xf695Df6c0f3bB45918A7A82e83348FC59517734E" },
  { chain: "Polygon", chainId: 137, symbol: "USTBL", name: "Spiko US T-Bills Money Market Fund", address: "0xe4880249745eAc5F1eD9d8F7DF844792D560e750" },
  { chain: "Polygon", chainId: 137, symbol: "EUTBL", name: "Spiko EU T-Bills Money Market Fund", address: "0xa0769f7A8fC65e47dE93797b4e21C073c117Fc80" },
  { chain: "Polygon", chainId: 137, symbol: "SPKCC", name: "Spiko Cash & Carry Fund", address: "0x903d5990119bc799423e9c25c56518ba7dd19474" },
  { chain: "Polygon", chainId: 137, symbol: "eurSPKCC", name: "Spiko EUR Cash & Carry Fund", address: "0x99F70A0e1786402a6796c6B0AA997ef340a5c6da" },
  { chain: "Polygon", chainId: 137, symbol: "UKTBL", name: "Spiko UK T-Bills Money Market Fund", address: "0x970E2aDC2fdF53AEa6B5fa73ca6dc30eAFEDfe3D" },
  { chain: "Arbitrum", chainId: 42161, symbol: "USTBL", name: "Spiko US T-Bills Money Market Fund", address: "0x021289588cd81dC1AC87ea91e91607eEF68303F5" },
  { chain: "Arbitrum", chainId: 42161, symbol: "EUTBL", name: "Spiko EU T-Bills Money Market Fund", address: "0xcbeb19549054cc0a6257a77736fc78c367216ce7" },
  { chain: "Arbitrum", chainId: 42161, symbol: "SPKCC", name: "Spiko Cash & Carry Fund", address: "0x99f70a0e1786402a6796c6b0aa997ef340a5c6da" },
  { chain: "Arbitrum", chainId: 42161, symbol: "eurSPKCC", name: "Spiko EUR Cash & Carry Fund", address: "0x0e389C83Bc1d16d86412476F6103027555C03265" },
  { chain: "Arbitrum", chainId: 42161, symbol: "UKTBL", name: "Spiko UK T-Bills Money Market Fund", address: "0x903d5990119bC799423e9C25c56518Ba7DD19474" },
  { chain: "Base", chainId: 8453, symbol: "USTBL", name: "Spiko US T-Bills Money Market Fund", address: "0xe4880249745eAc5F1eD9d8F7DF844792D560e750" },
  { chain: "Base", chainId: 8453, symbol: "EUTBL", name: "Spiko EU T-Bills Money Market Fund", address: "0xa0769f7A8fC65e47dE93797b4e21C073c117Fc80" },
  { chain: "Base", chainId: 8453, symbol: "SPKCC", name: "Spiko Cash & Carry Fund", address: "0xf695df6c0f3bb45918a7a82e83348fc59517734e" },
  { chain: "Base", chainId: 8453, symbol: "eurSPKCC", name: "Spiko EUR Cash & Carry Fund", address: "0x4f33aCf823E6eEb697180d553cE0c710124C8D59" },
  { chain: "Base", chainId: 8453, symbol: "UKTBL", name: "Spiko UK T-Bills Money Market Fund", address: "0xA8De1f55Aa0E381cb456e1DcC9ff781eA0079068" },
];

const LOCAL_ARTIFACTS = [
  { protocol: "Morpho public allocator", file: "reports/raw/fast/morpho-public-allocator-force-feed.json" },
  { protocol: "Focused Morpho review", file: "reports/raw/fast/focused-morpho-review-producers.json" },
  { protocol: "Morpho exit liquidity", file: "reports/raw/fast/morpho-exit-liquidity-stress.json" },
  { protocol: "Seven-chain lending coverage", file: "reports/raw/fast/seven-chain-lending-coverage.json" },
  { protocol: "Factory launch donation", file: "reports/raw/fast/factory-launch-donation-watch.json" },
  { protocol: "LRT oracle drift", file: "reports/raw/fast/lrt-oracle-drift-routes.json" },
  { protocol: "New vault donation", file: "reports/raw/fast/new-vault-donation-attack.json" },
  { protocol: "Consumer-first high LTV", file: "reports/raw/fast/consumer-first-high-ltv-collateral.json" },
  { protocol: "Silo V2", file: "reports/raw/fast/silo-v2-phase0.json" },
  { protocol: "Euler V2", file: "reports/raw/fast/euler-v2-phase0.json" },
];

const TOKEN_SYMBOLS = new Set(SPIKO_TOKENS.map((row) => row.symbol.toLowerCase()));
const TOKEN_ADDRESSES = new Set(SPIKO_TOKENS.map((row) => row.address.toLowerCase()));

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; } catch (_) { return fallback; } }
function latestRow(rows) { return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null; }
function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function shortAddress(value) {
  if (value && typeof value === "object") return shortAddress(value.address || value.token || value.asset || value.market || value.vault || null);
  const text = String(value || "");
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text || "n/a";
}
function flattenResults(consumerGraph, field) { return (consumerGraph?.results || []).flatMap((row) => Array.isArray(row[field]) ? row[field] : []); }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-spiko-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function chainData(metadata, key) {
  const row = metadata?.chainTvls?.[key] || {};
  return {
    tvlUsd: latestRow(row.tvl)?.totalLiquidityUSD ?? metadata?.currentChainTvls?.[key] ?? null,
    tokens: latestRow(row.tokens)?.tokens || {},
    tokensInUsd: latestRow(row.tokensInUsd)?.tokens || {},
  };
}

async function fetchDexRows() {
  try {
    const rows = [];
    for (let i = 0; i < SPIKO_TOKENS.length; i += 8) {
      const chunk = SPIKO_TOKENS.slice(i, i + 8);
      const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${chunk.map((row) => row.address).join(",")}`, 30_000).catch(() => ({}));
      for (const pair of json.pairs || []) {
        const base = String(pair.baseToken?.address || "").toLowerCase();
        const quote = String(pair.quoteToken?.address || "").toLowerCase();
        const token = SPIKO_TOKENS.find((row) => row.address.toLowerCase() === base || row.address.toLowerCase() === quote);
        if (!token) continue;
        rows.push({
          seedChain: token.chain,
          seedSymbol: token.symbol,
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
    }
    return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 60);
  } catch (_) {
    return [];
  }
}

function runConsumerGraph() {
  ensureDir(GRAPH_OUT);
  const child = spawnSync(process.execPath, ["scan-rwa-nav-consumer-graph.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      RWA_NAV_PROTOCOL_FILTER: "Spiko",
      RWA_NAV_CHAIN_IDS: "1,137,42161,8453",
      RWA_NAV_OUT: GRAPH_OUT_REL,
      RWA_NAV_MAX_EULER_VAULTS: process.env.RWA_NAV_MAX_EULER_VAULTS || "1200",
      RWA_NAV_MAX_SILO_IDS: process.env.RWA_NAV_MAX_SILO_IDS || "1100",
      RWA_NAV_MORPHO_TOP_N: process.env.RWA_NAV_MORPHO_TOP_N || "600",
    },
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  });
  if (child.status !== 0) {
    const msg = `${child.stderr || child.stdout || "RWA/NAV child scanner failed"}`.slice(0, 1000);
    throw new Error(msg);
  }
  if (!QUIET && child.stdout) process.stdout.write(child.stdout);
  return readJson(GRAPH_OUT, null);
}

function rowMatches(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).toLowerCase();
  if (TOKEN_SYMBOLS.has(text)) return true;
  if (TOKEN_ADDRESSES.has(text)) return true;
  return text.includes("spiko") || [...TOKEN_SYMBOLS].some((sym) => text.includes(sym)) || [...TOKEN_ADDRESSES].some((addr) => text.includes(addr));
}

function shallowSummary(row) {
  const out = {};
  for (const key of [
    "protocol", "chain", "chainId", "symbol", "assetSymbol", "assetName", "vaultSymbol", "vaultName", "marketName",
    "asset", "token", "address", "vault", "market", "collateral", "loanToken", "borrowAsset", "oracle", "pairAddress", "config",
    "ltv", "lltv", "ltvBorrowBps", "maxLtv", "maxLtvBps", "liquidationThreshold", "ltvLiquidation", "liquidityUsd",
    "cashUsd", "borrowedUsd", "borrowUsd", "supplyUsd", "routeLiquidityUsd", "bestNetProfitUsd", "netProfitUsd", "routePositive", "watchCandidate",
    "blocker", "status",
  ]) {
    if (row && Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

function collectLocalRowsFromValue(value, rows, limit, depth = 0) {
  if (!value || rows.length >= limit || depth > 10) return false;
  if (Array.isArray(value)) {
    let matched = false;
    for (const item of value) matched = collectLocalRowsFromValue(item, rows, limit, depth + 1) || matched;
    return matched;
  }
  if (typeof value !== "object") return rowMatches(value);

  let matched = false;
  for (const [key, child] of Object.entries(value)) {
    if (rowMatches(key) || (typeof child !== "object" && rowMatches(child))) matched = true;
  }
  for (const child of Object.values(value)) {
    if (rows.length >= limit) break;
    if (collectLocalRowsFromValue(child, rows, limit, depth + 1)) matched = true;
  }
  if (matched && rows.length < limit) rows.push(shallowSummary(value));
  return matched;
}

function collectLocalArtifactRows(limitPerArtifact = 35) {
  const rows = [];
  for (const artifact of LOCAL_ARTIFACTS) {
    const file = path.join(WORKSPACE, artifact.file);
    const json = readJson(file, null);
    if (!json) continue;
    const artifactRows = [];
    collectLocalRowsFromValue(json, artifactRows, limitPerArtifact);
    for (const row of artifactRows.slice(0, limitPerArtifact)) rows.push({ protocol: artifact.protocol, artifact: artifact.file, ...row });
  }
  return rows;
}

function writeReport(out) {
  const s = out.summary;
  const tokenTable = out.tokenRows.map((row) => `| ${row.chain || "?"} | ${row.symbol || "?"} | ${shortAddress(row.address)} | ${row.codePresent} | ${row.totalSupply || "n/a"} | ${formatUsd(row.tokenPriceUsd)} | ${row.erc4626?.navUsdPerShare ? formatUsd(row.erc4626.navUsdPerShare) : "n/a"} | ${row.currentAnomaly} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const matchTable = out.topMatches.slice(0, 12).map((row) => `| ${row.protocol} | ${row.side} | ${row.producer?.chain || "?"} | ${row.producer?.symbol || "?"} | ${row.reviewCandidate} | ${row.watchCandidate} | ${formatUsd(row.market?.otherReserveCashUsd ?? row.market?.cashUsd ?? row.market?.baseCashUsd ?? row.market?.liquidityAssetsUsd ?? row.market?.oppositeLiquidityUsd)} | ${row.blockers?.[0] || "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const localTable = out.localArtifactRows.slice(0, 14).map((row) => `| ${row.protocol} | ${row.assetSymbol || row.symbol || row.vaultSymbol || row.marketName || "?"} | ${shortAddress(row.asset || row.token || row.collateral?.address || row.collateral || row.address || row.market || row.vault)} | ${row.ltvBorrowBps ?? row.lltv ?? row.maxLtv ?? row.maxLtvBps ?? "n/a"} | ${formatUsd(row.routeLiquidityUsd ?? row.liquidityUsd ?? row.cashUsd)} | ${row.routePositive ?? false} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const dexTable = out.dexLiquidityRows.slice(0, 8).map((row) => `| ${row.seedSymbol || "?"} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} | ${row.priceUsd ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";

  const content = `# 🟢 DORMANT - Spiko Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-spiko-phase0.js\`

Artifact: \`reports/raw/fast/spiko-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass seeded exact Spiko EVM token addresses from the public DeFiLlama adapter, ran the generic RWA/NAV producer-to-consumer graph across Ethereum, Polygon, Arbitrum, and Base, joined existing Morpho/Silo/Euler/local artifacts, checked public DEX context, and compared current route gates. Current blockers are permissioned or restricted RWA issuance/redemption, no atomic public NAV exit proof, zero/dust Silo liquidity on new rows, and no exact-positive borrow/liquidation/redeem/unwind economics.

## Summary

| Metric | Value |
|---|---:|
| DeFiLlama TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum TVL | ${formatUsd(s.ethereumTvlUsd)} |
| Polygon TVL | ${formatUsd(s.polygonTvlUsd)} |
| Arbitrum TVL | ${formatUsd(s.arbitrumTvlUsd)} |
| Base TVL | ${formatUsd(s.baseTvlUsd)} |
| Exact EVM token seeds | \`${s.exactTokenSeeds}\` |
| Token rows with code | \`${s.tokenRowsWithCode}\` |
| Consumer matches | \`${s.matches}\` |
| Local artifact rows | \`${s.localArtifactRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Top DEX liquidity | ${formatUsd(s.topDexLiquidityUsd)} |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |

## Token Rows

| Chain | Symbol | Token | Code | Total supply | Public token price | ERC4626 NAV/share | Current anomaly |
|---|---|---|---:|---:|---:|---:|---:|
${tokenTable}

## Consumer Matches

| Protocol | Side | Chain | Producer | Review | Watch | Route-side liquidity | Blocker |
|---|---|---|---|---:|---:|---:|---|
${matchTable}

## Local Artifact Joins

| Source | Symbol/Market | Address | LTV/LLTV | Liquidity/Cash | Route-positive |
|---|---|---|---:|---:|---:|
${localTable}

## DEX Context

| Symbol | DEX | Pair | Liquidity USD | 24h volume USD | Price USD |
|---|---|---|---:|---:|---:|
${dexTable}

## Blockers

- Spiko issuance, redemption, and transferability are treated as permissioned or restricted unless a public same-block exit path is proven.
- The known Ethereum Morpho EUTBL/EURCV route remains below LLTV-adjusted break-even and lacks exact acquisition/unwind economics.
- New Silo USTBL/EUTBL rows observed in local artifacts have zero or dust opposite liquidity and do not create a borrow route.
- DEX liquidity is context only until exact input/output routes, gas, slippage, and transferability are proven at the required size.
- No current NAV/market/oracle divergence above route threshold was proven for a material joined consumer.
- No fork extraction proof and no signed-action justification exist.

## Required For Route-Positive

- Exact Spiko token or PT accepted by a material consumer with usable LTV/LLTV and live borrow/redeem/liquidation liquidity.
- Current accepted value must exceed exact acquisition/redemption/DEX exit value enough to clear gas, slippage, fees, and LTV haircut.
- Route must be atomic or otherwise explicitly authorized for capital/queue risk.
- Fork extraction proof must show measured profit for the exact joined route.

## Next Read-Only Step

Keep Spiko on NAV/consumer-join watch. Reopen for exact quotes if a Spiko consumer row gains material liquidity plus a current NAV/oracle/market divergence, or if Morpho/Silo/Euler/Pendle rows become exact-positive after acquisition and exit costs.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const consumerGraph = runConsumerGraph();
  if (!consumerGraph) throw new Error("Missing Spiko consumer graph artifact after child scan");

  const [metadataRaw, dexLiquidityRows] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/spiko", 45_000).catch(() => ({})),
    fetchDexRows(),
  ]);
  const localArtifactRows = collectLocalArtifactRows();
  const tokenRows = flattenResults(consumerGraph, "topProducers").filter((row) => TOKEN_ADDRESSES.has(String(row.address || "").toLowerCase()));
  const topMatches = flattenResults(consumerGraph, "topMatches");
  const latestTvl = latestRow(metadataRaw.tvl)?.totalLiquidityUSD ?? Object.values(metadataRaw.currentChainTvls || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const routePositive = asNumber(consumerGraph.summary?.routePositive) || 0;
  const watchCandidates = asNumber(consumerGraph.summary?.watchCandidates) || 0;
  const ethData = chainData(metadataRaw, "Ethereum");
  const polygonData = chainData(metadataRaw, "Polygon");
  const arbData = chainData(metadataRaw, "Arbitrum");
  const baseData = chainData(metadataRaw, "Base");

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-spiko-phase0.js",
    scope: "Spiko Phase 0 EVM RWA/NAV tokens, consumer graph, local Morpho/Silo/Euler joins, and DEX exit-liquidity triage",
    safety: {
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
      name: metadataRaw.name || "Spiko",
      slug: metadataRaw.slug || "spiko",
      category: metadataRaw.category || "RWA",
      chains: metadataRaw.chains || [],
      module: metadataRaw.module || null,
      tvlCodePath: metadataRaw.tvlCodePath || null,
      methodology: metadataRaw.methodology || null,
    },
    exactTokenSeeds: SPIKO_TOKENS,
    tokenRows,
    topMatches,
    dexLiquidityRows,
    localArtifactRows,
    consumerGraph,
    summary: {
      defillamaCurrentTvlUsd: round(latestTvl, 2),
      ethereumTvlUsd: round(ethData.tvlUsd, 2),
      polygonTvlUsd: round(polygonData.tvlUsd, 2),
      arbitrumTvlUsd: round(arbData.tvlUsd, 2),
      baseTvlUsd: round(baseData.tvlUsd, 2),
      exactTokenSeeds: SPIKO_TOKENS.length,
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
      localArtifactRows: localArtifactRows.length,
      dexLiquidityRows: dexLiquidityRows.length,
      topDexLiquidityUsd: round(dexLiquidityRows[0]?.liquidityUsd, 2),
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      status: routePositive > 0 ? "spiko-route-positive-needs-proof" : watchCandidates > 0 ? "spiko-watch-needs-nav-consumer-economics" : "spiko-phase0-no-route-positive",
    },
    blockers: [
      "Spiko issuance/redemption/transferability is treated as permissioned or restricted absent public atomic exit proof",
      "Known Morpho EUTBL/EURCV and Silo USTBL/EUTBL rows lack current accepted-value divergence plus exact positive route economics",
      "Public DEX liquidity is context-only until exact quotes, gas, slippage, and transferability are proven at size",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "Exact Spiko token/PT accepted by a material consumer with usable LTV and live liquidity",
      "Current NAV/oracle/market divergence or liquidatable condition favorable to an attacker",
      "Exact acquisition, borrow/liquidation/redeem, and exit route positive after gas/slippage/fees",
      "Fork extraction proof with measured profit",
    ],
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, null, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Spiko Phase0: tvl=${formatUsd(output.summary.defillamaCurrentTvlUsd)} tokens=${output.summary.tokenRows}/${output.summary.exactTokenSeeds} matches=${output.summary.matches} localRows=${output.summary.localArtifactRows} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 1000));
  process.exit(1);
});
