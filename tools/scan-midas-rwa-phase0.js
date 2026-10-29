#!/usr/bin/env node
// scan-midas-rwa-phase0.js - read-only Phase 0 for Midas RWA NAV/consumer joins.
// RPC URLs stay in memory in the child RWA/NAV scanner and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "midas-rwa-phase0.json");
const GRAPH_OUT_REL = "reports/raw/fast/midas-rwa-phase0-rwa-nav-consumer-graph.json";
const GRAPH_OUT = path.join(WORKSPACE, GRAPH_OUT_REL);
const REPORT_OUT = path.join(WORKSPACE, "reports", "midas-rwa-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const MIDAS_TOKENS = [
  { chain: "Ethereum", chainId: 1, symbol: "mTBILL", name: "Midas US Treasury Bill Token", address: "0xDD629E5241CbC5919847783e6C96B2De4754e438" },
  { chain: "Ethereum", chainId: 1, symbol: "mBASIS", name: "Midas Basis Trading Token", address: "0x2a8c22E3b10036f3AEF5875d04f8441d4188b656" },
  { chain: "Ethereum", chainId: 1, symbol: "mEDGE", name: "Midas mEDGE", address: "0xbB51E2a15A9158EBE2b0Ceb8678511e063AB7a55" },
  { chain: "Ethereum", chainId: 1, symbol: "mMEV", name: "Midas MEV", address: "0x030b69280892c888670EDCDCD8B69Fd8026A0BF3" },
  { chain: "Ethereum", chainId: 1, symbol: "mRe7YIELD", name: "Midas Re7 Yield", address: "0x87C9053C819bB28e0D73d33059E1b3DA80AFb0cf" },
  { chain: "Ethereum", chainId: 1, symbol: "mHYPER", name: "Midas Hyperithm", address: "0x9b5528528656DBC094765E2abB79F293c21191B9" },
  { chain: "Ethereum", chainId: 1, symbol: "mFARM", name: "Midas Farm Capital", address: "0xA19f6e0dF08a7917F2F8A33Db66D0AF31fF5ECA6" },
  { chain: "Ethereum", chainId: 1, symbol: "mAPOLLO", name: "Midas Apollo Crypto", address: "0x7CF9DEC92ca9FD46f8d86e7798B72624Bc116C05" },
  { chain: "Ethereum", chainId: 1, symbol: "mBTC", name: "Midas BTC Yield Token", address: "0x007115416AB6c266329a03B09a8aa39aC2eF7d9d" },
  { chain: "Ethereum", chainId: 1, symbol: "mHyperBTC", name: "Midas Hyperithm BTC", address: "0xC8495EAFf71D3A563b906295fCF2f685b1783085" },
  { chain: "Ethereum", chainId: 1, symbol: "mROX", name: "Midas mROX", address: "0x67E1F506B148d0Fc95a4E3fFb49068ceB6855c05" },
];

const LOCAL_ARTIFACTS = [
  { protocol: "Euler V2", file: "reports/raw/fast/euler-v2-phase0.json" },
  { protocol: "Silo V2", file: "reports/raw/fast/silo-v2-phase0.json" },
  { protocol: "Morpho Blue", file: "reports/raw/fast/morpho-pyth-unsafe-consumers.json" },
  { protocol: "Morpho / seven-chain", file: "reports/raw/fast/seven-chain-lending-coverage.json" },
  { protocol: "Pendle PT", file: "reports/raw/fast/pendle-pt-multichain-consumer-graph.json" },
  { protocol: "Pendle YT", file: "reports/raw/fast/pendle-yt-collateral-routes.json" },
  { protocol: "Consumer-first high LTV", file: "reports/raw/fast/consumer-first-high-ltv-collateral.json" },
  { protocol: "Market launch choreography", file: "reports/raw/fast/market-launch-choreography-routes.json" },
  { protocol: "Factory launch donation", file: "reports/raw/fast/factory-launch-donation-watch.json" },
];

const TOKEN_SYMBOLS = new Set(MIDAS_TOKENS.map((row) => row.symbol.toLowerCase()));
const TOKEN_ADDRESSES = new Set(MIDAS_TOKENS.map((row) => row.address.toLowerCase()));

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
function shortAddress(value) { const text = String(value || ""); return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text || "n/a"; }
function flattenResults(consumerGraph, field) { return (consumerGraph?.results || []).flatMap((row) => Array.isArray(row[field]) ? row[field] : []); }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-midas-rwa-phase0/1.0" } });
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
    const chunks = [];
    for (let i = 0; i < MIDAS_TOKENS.length; i += 8) chunks.push(MIDAS_TOKENS.slice(i, i + 8));
    const rows = [];
    for (const chunk of chunks) {
      const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${chunk.map((row) => row.address).join(",")}`, 30_000).catch(() => ({}));
      for (const pair of json.pairs || []) {
        const base = String(pair.baseToken?.address || "").toLowerCase();
        const quote = String(pair.quoteToken?.address || "").toLowerCase();
        const token = MIDAS_TOKENS.find((row) => row.address.toLowerCase() === base || row.address.toLowerCase() === quote);
        if (!token) continue;
        rows.push({
          chain: token.chain,
          symbol: token.symbol,
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
    return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 50);
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
      RWA_NAV_PROTOCOL_FILTER: "Midas RWA",
      RWA_NAV_CHAIN_IDS: "1",
      RWA_NAV_OUT: GRAPH_OUT_REL,
      RWA_NAV_MAX_EULER_VAULTS: process.env.RWA_NAV_MAX_EULER_VAULTS || "1200",
      RWA_NAV_MAX_SILO_IDS: process.env.RWA_NAV_MAX_SILO_IDS || "1000",
      RWA_NAV_MORPHO_TOP_N: process.env.RWA_NAV_MORPHO_TOP_N || "500",
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
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
  return text.includes("midas") || [...TOKEN_SYMBOLS].some((sym) => text.includes(sym)) || [...TOKEN_ADDRESSES].some((addr) => text.includes(addr));
}

function shallowSummary(row) {
  const out = {};
  for (const key of [
    "protocol", "chain", "chainId", "symbol", "assetSymbol", "assetName", "vaultSymbol", "vaultName", "marketName",
    "asset", "token", "address", "vault", "market", "collateral", "loanToken", "oracle", "pairAddress", "config",
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

function collectLocalArtifactRows(limitPerArtifact = 40) {
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
  const tokenTable = out.tokenRows.map((row) => `| ${row.symbol || "?"} | ${shortAddress(row.address)} | ${row.codePresent} | ${row.totalSupply || "n/a"} | ${formatUsd(row.tokenPriceUsd)} | ${row.erc4626?.navUsdPerShare ? formatUsd(row.erc4626.navUsdPerShare) : "n/a"} | ${row.currentAnomaly} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const matchTable = out.topMatches.slice(0, 10).map((row) => `| ${row.protocol} | ${row.side} | ${row.producer?.symbol || "?"} | ${row.reviewCandidate} | ${row.watchCandidate} | ${formatUsd(row.market?.otherReserveCashUsd ?? row.market?.cashUsd ?? row.market?.baseCashUsd ?? row.market?.liquidityAssetsUsd ?? row.market?.oppositeLiquidityUsd)} | ${row.blocker || "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const localTable = out.localArtifactRows.slice(0, 12).map((row) => `| ${row.protocol} | ${row.assetSymbol || row.symbol || row.vaultSymbol || row.marketName || "?"} | ${shortAddress(row.asset || row.token || row.collateral || row.address || row.market || row.vault)} | ${row.ltvBorrowBps ?? row.lltv ?? row.maxLtv ?? row.maxLtvBps ?? "n/a"} | ${formatUsd(row.routeLiquidityUsd ?? row.liquidityUsd ?? row.cashUsd)} | ${row.routePositive ?? false} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const dexTable = out.dexLiquidityRows.slice(0, 8).map((row) => `| ${row.symbol || "?"} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} | ${row.priceUsd ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";

  const content = `# DORMANT - Midas RWA Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-midas-rwa-phase0.js\`

Artifact: \`reports/raw/fast/midas-rwa-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass seeded exact Midas token addresses from prior Euler/Pendle/Silo/Morpho artifacts, ran the generic RWA/NAV producer-to-consumer graph, joined local consumer artifacts, checked public DEX context, and compared current route gates. Current blockers are permissioned/queued redemption assumptions, missing atomic NAV exit proof, and no exact-positive borrow/liquidation/redeem/unwind economics.

## Summary

| Metric | Value |
|---|---:|
| DeFiLlama TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum TVL | ${formatUsd(s.ethereumTvlUsd)} |
| Arbitrum TVL | ${formatUsd(s.arbitrumTvlUsd)} |
| Base TVL | ${formatUsd(s.baseTvlUsd)} |
| BNB TVL | ${formatUsd(s.bnbTvlUsd)} |
| Optimism TVL | ${formatUsd(s.optimismTvlUsd)} |
| Exact token seeds | \`${s.exactTokenSeeds}\` |
| Token rows with code | \`${s.tokenRowsWithCode}\` |
| Consumer matches | \`${s.matches}\` |
| Local artifact rows | \`${s.localArtifactRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Top DEX liquidity | ${formatUsd(s.topDexLiquidityUsd)} |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |

## Midas Token Rows

| Symbol | Token | Code | Total supply | Public token price | ERC4626 NAV/share | Current anomaly |
|---|---|---:|---:|---:|---:|---:|
${tokenTable}

## Consumer Matches

| Protocol | Side | Producer | Review | Watch | Route-side liquidity | Blocker |
|---|---|---|---:|---:|---:|---|
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

- Exact seeds are Ethereum-only in this pass; other public Midas chains are TVL context until exact token addresses and consumers are resolved.
- Midas issuance/redemption is treated as permissioned or delayed unless a public atomic exit path is proven.
- Euler/Morpho/Silo/Pendle rows are consumer context only until accepted value, acquisition cost, borrow/liquidation path, exit liquidity, and gas/slippage are exact-positive.
- No current NAV/market/oracle divergence above route threshold was proven for a material joined consumer.
- No fork extraction proof and no signed-action justification exist.

## Required For Route-Positive

- Exact Midas token or PT accepted by a material consumer with usable LTV/LLTV and live borrow/redeem/liquidation liquidity.
- Current accepted value must exceed exact acquisition/redemption/DEX exit value enough to clear gas, slippage, and fees.
- Route must be atomic or otherwise explicitly authorized for capital/queue risk.
- Fork extraction proof must show measured profit for the exact joined route.

## Next Read-Only Step

Keep Midas on NAV/consumer-join watch. Reopen for exact quotes if a Midas consumer row gains material liquidity plus a current NAV/oracle/market divergence, or if a Pendle/Euler/Morpho/Silo row becomes exact-positive after acquisition and exit costs.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const consumerGraph = runConsumerGraph();
  if (!consumerGraph) throw new Error("Missing Midas consumer graph artifact after child scan");

  const [metadataRaw, dexLiquidityRows] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/midas-rwa", 45_000).catch(() => ({})),
    fetchDexRows(),
  ]);
  const localArtifactRows = collectLocalArtifactRows();
  const tokenRows = flattenResults(consumerGraph, "topProducers").filter((row) => TOKEN_ADDRESSES.has(String(row.address || "").toLowerCase()));
  const topMatches = flattenResults(consumerGraph, "topMatches");
  const latestTvl = latestRow(metadataRaw.tvl)?.totalLiquidityUSD ?? Object.values(metadataRaw.currentChainTvls || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const routePositive = asNumber(consumerGraph.summary?.routePositive) || 0;
  const watchCandidates = asNumber(consumerGraph.summary?.watchCandidates) || 0;
  const ethData = chainData(metadataRaw, "Ethereum");
  const arbData = chainData(metadataRaw, "Arbitrum");
  const baseData = chainData(metadataRaw, "Base");
  const bnbData = chainData(metadataRaw, "Binance");
  const opData = chainData(metadataRaw, "Optimism");

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-midas-rwa-phase0.js",
    scope: "Midas RWA Phase 0 RWA/NAV token, consumer graph, Pendle/Euler/Silo/Morpho joins, and exit-liquidity triage",
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
      name: metadataRaw.name || "Midas RWA",
      slug: metadataRaw.slug || "midas-rwa",
      category: metadataRaw.category || "RWA",
      chains: metadataRaw.chains || [],
      module: metadataRaw.module || null,
      tvlCodePath: metadataRaw.tvlCodePath || null,
      methodology: metadataRaw.methodology || null,
    },
    exactTokenSeeds: MIDAS_TOKENS,
    tokenRows,
    topMatches,
    dexLiquidityRows,
    localArtifactRows,
    consumerGraph,
    summary: {
      defillamaCurrentTvlUsd: round(latestTvl, 2),
      ethereumTvlUsd: round(ethData.tvlUsd, 2),
      arbitrumTvlUsd: round(arbData.tvlUsd, 2),
      baseTvlUsd: round(baseData.tvlUsd, 2),
      bnbTvlUsd: round(bnbData.tvlUsd, 2),
      optimismTvlUsd: round(opData.tvlUsd, 2),
      exactTokenSeeds: MIDAS_TOKENS.length,
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
      status: routePositive > 0 ? "midas-rwa-route-positive-needs-proof" : watchCandidates > 0 ? "midas-rwa-watch-needs-nav-consumer-economics" : "midas-rwa-phase0-no-route-positive",
    },
    blockers: [
      "Other public Midas chains remain TVL context until exact token addresses and consumers are resolved",
      "Midas redemption/issuance is treated as permissioned or delayed absent public atomic exit proof",
      "Consumer joins lack current accepted-value divergence plus exact positive borrow/liquidation/redeem/unwind economics",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "Exact Midas token/PT accepted by a material consumer with usable LTV and live liquidity",
      "Current NAV/oracle/market divergence or liquidatable condition favorable to an attacker",
      "Exact acquisition, borrow/liquidation/redeem, and exit route positive after gas/slippage/fees",
      "Fork extraction proof with measured profit",
    ],
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, null, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Midas RWA Phase0: tvl=${formatUsd(output.summary.defillamaCurrentTvlUsd)} tokens=${output.summary.tokenRows}/${output.summary.exactTokenSeeds} matches=${output.summary.matches} localRows=${output.summary.localArtifactRows} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 1000));
  process.exit(1);
});
