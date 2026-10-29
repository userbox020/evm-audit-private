#!/usr/bin/env node
// scan-tether-gold-phase0.js - read-only Phase 0 wrapper for Tether Gold / XAUt.
// RPC URLs stay in memory in the child scanner and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "tether-gold-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "tether-gold-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const ADAPTER_TOKENS = [
  { chain: "Ethereum", chainId: 1, adapterKey: "ethereum", token: "0x68749665ff8d2d112fa859aa293f07a622782f38" },
  { chain: "Avalanche", llamaKey: "Avalanche", chainId: 43114, adapterKey: "avax", token: "0x2775d5105276781b4b85ba6ea6a6653beed1dd32" },
  { chain: "Arbitrum", llamaKey: "Arbitrum", chainId: 42161, adapterKey: "arbitrum", token: "0x40461291347e1ecbb09499f3371d3f17f10d7159" },
  { chain: "Celo", llamaKey: "Celo", chainId: 42220, adapterKey: "celo", token: "0xaf37e8b6c9ed7f6318979f56fc287d76c30847ff" },
  { chain: "Ink", llamaKey: "Ink", chainId: 57073, adapterKey: "ink", token: "0xf50258d3c1dd88946c567920b986a12e65b50dac" },
];

const EXTRA_CONTEXT_TOKENS = [
  { chain: "BNB Chain", chainId: 56, adapterKey: "bsc", token: "0x21cAef8A43163Eea865baeE23b9C2E327696A3bf", source: "local Lista DEX XAUt loan-token row" },
];

const NON_RPC_OR_ADAPTER_CONTEXT = [
  { chain: "Monad", token: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", note: "adapter-listed, no current local RPC scan support in this wrapper" },
  { chain: "Plasma", token: "0x1b64b9025eebb9a6239575df9ea4b9ac46d4d193", note: "adapter-listed, no current local RPC scan support in this wrapper" },
  { chain: "Polygon", token: "0xf1815bd50389c46847f0bda824ec8da914045d14", note: "adapter resolves through ADDRESSES.flow.stgUSDC; excluded from exact XAUt seed scan until token identity is verified" },
];

const LOCAL_ARTIFACTS = [
  { protocol: "Aave V4", file: "reports/raw/fast/aave-v4-liquidation-watch.json" },
  { protocol: "Fluid Lending", file: "reports/raw/fast/fluid-lending-phase0.json" },
  { protocol: "Fluid DEX", file: "reports/raw/fast/fluid-dex-phase0.json" },
  { protocol: "Compound V3", file: "reports/raw/fast/compound-v3-phase0.json" },
  { protocol: "Euler V2", file: "reports/raw/fast/euler-v2-phase0.json" },
  { protocol: "Lista DEX", file: "reports/raw/fast/lista-dex-phase0.json" },
  { protocol: "Curve DEX", file: "reports/raw/fast/curve-dex-phase0.json" },
];

const TOKEN_SET = new Set([...ADAPTER_TOKENS, ...EXTRA_CONTEXT_TOKENS].map((row) => row.token.toLowerCase()));

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

function formatPct(value) {
  const n = asNumber(value);
  return n === null ? "n/a" : `${round(n, 2)}%`;
}

function formatBps(value) {
  const n = asNumber(value);
  return n === null ? "n/a" : `${round(n, 4)}bps`;
}

function shortAddress(value) {
  const text = String(value || "");
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text || "n/a";
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-tether-gold-phase0/1.0" } });
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

function tokenMentionsXaut(value) {
  const text = String(value || "");
  if (TOKEN_SET.has(text.toLowerCase())) return true;
  return /(^|[^a-z0-9])xaut([^a-z0-9]|$)/i.test(text) || /(^|[^a-z0-9])xau\/usd([^a-z0-9]|$)/i.test(text);
}

function objectMentionsXaut(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && tokenMentionsXaut(value)) return true;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (["symbol", "name", "assetSymbol", "loanTokenName", "supplySymbol", "borrowSymbol", "description"].some((k) => tokenMentionsXaut(value[k]))) return true;
    }
  }
  return false;
}

function rowish(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return Boolean(
    obj.label || obj.name || obj.market || obj.assetSymbol || obj.supplySymbol || obj.loanTokenName ||
    obj.vaultSymbol || obj.symbolPair || obj.feedDescription || obj.topCollateral || obj.loanTokenMeta || obj.collateralAsset
  );
}

function collectObjects(root, limit = 80) {
  const rows = [];
  const seen = new Set();
  function walk(value) {
    if (rows.length >= limit || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (rowish(value) && objectMentionsXaut(value)) {
      const key = JSON.stringify([
        value.chainId || value.chain || value.chainName || "",
        value.address || value.vault || value.comet || value.marketId || value.market || value.name || value.label || value.vaultSymbol || "",
        value.asset || value.loanToken || value.collateralAsset || value.supplyToken0 || value.borrowToken0 || value.topCollateral?.symbol || "",
      ]).slice(0, 500);
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(value);
      }
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(root);
  return rows;
}

function maxNumber(...values) {
  const nums = values.map(asNumber).filter((n) => n !== null);
  return nums.length ? Math.max(...nums) : null;
}

function inferSide(obj) {
  if (tokenMentionsXaut(obj.supplySymbol) || tokenMentionsXaut(obj.assetSymbol) || tokenMentionsXaut(obj.collateralSymbol) || tokenMentionsXaut(obj.topCollateral?.symbol)) return "collateral-or-asset";
  if (tokenMentionsXaut(obj.loanTokenName) || tokenMentionsXaut(obj.borrowSymbol) || tokenMentionsXaut(obj.baseSymbol)) return "loan-or-borrow";
  if (tokenMentionsXaut(obj.symbolPair) || tokenMentionsXaut(obj.name) || tokenMentionsXaut(obj.label)) return "pool-or-pair";
  if (tokenMentionsXaut(obj.feedDescription)) return "oracle-feed";
  return "context";
}

function inferLabel(obj) {
  return obj.label || obj.name || obj.vaultSymbol || obj.market || obj.symbolPair || obj.feedDescription || obj.topCollateral?.symbol || obj.assetSymbol || "XAUt row";
}

function inferChain(obj) {
  if (obj.chainName) return obj.chainName;
  if (obj.chain) return obj.chain;
  if (obj.chainId === 1) return "Ethereum";
  if (obj.chainId === 56) return "BNB Chain";
  if (obj.chainId === 42161) return "Arbitrum";
  if (obj.chainId === 43114) return "Avalanche";
  if (obj.chainId === 42220) return "Celo";
  if (obj.chainId === 57073) return "Ink";
  return "n/a";
}

function inferLtv(obj) {
  if (obj.collateralFactorBps !== undefined || obj.liquidationThresholdBps !== undefined) return `${round((asNumber(obj.collateralFactorBps) || 0) / 100, 2)}% / ${round((asNumber(obj.liquidationThresholdBps) || 0) / 100, 2)}%`;
  if (obj.borrowCFBps !== undefined || obj.liquidateCFBps !== undefined) return `${round((asNumber(obj.borrowCFBps) || 0) / 100, 2)}% / ${round((asNumber(obj.liquidateCFBps) || 0) / 100, 2)}%`;
  if (obj.lltv !== undefined) return formatPct((asNumber(obj.lltv) || 0) * 100);
  if (obj.maxLtvBorrowBps !== undefined) return formatPct((asNumber(obj.maxLtvBorrowBps) || 0) / 100);
  return "n/a";
}

function inferAnomalyBps(obj) {
  return maxNumber(
    obj.externalDivergenceBps,
    obj.oracleOperateVsLiquidateDivergenceBps,
    obj.priceVsReferenceBps,
    obj.topCollateral?.priceVsReferenceBps
  );
}

function inferBlocker(obj) {
  if (obj.blocker) return obj.blocker;
  if (obj.routePositive === false) return "source artifact marks this XAUt row route-negative";
  if (obj.watchCandidate === false) return "source artifact does not classify this XAUt row as a watch candidate";
  if (obj.quoteRequired === false) return "quote not required by source artifact; not material/liquidatable";
  return "context row only; exact accepted-value, acquisition, liquidation/borrow, and unwind economics are not proven";
}

function toLocalRow(source, obj) {
  const routeLiquidityUsd = maxNumber(obj.borrowableUsd, obj.marketBaseCashUsd, obj.cashUsd, obj.borrowLiquidityUsd, obj.liquidityAssetsUsd, obj.oppositeLiquidityUsd);
  const contextUsd = maxNumber(obj.totalSupplyUsd, obj.assetValueUsd, obj.totalAssetsUsd, obj.poolTvlUsd, obj.collateralUsd, obj.suppliedUsd, obj.supplyUsd);
  const anomalyBps = inferAnomalyBps(obj);
  return {
    sourceArtifact: source.file,
    protocol: source.protocol,
    chain: inferChain(obj),
    label: inferLabel(obj),
    side: inferSide(obj),
    ltv: inferLtv(obj),
    routeLiquidityUsd: round(routeLiquidityUsd, 2),
    contextUsd: round(contextUsd, 2),
    anomalyBps: round(anomalyBps, 4),
    routePositive: Boolean(obj.routePositive),
    watchCandidate: Boolean(obj.watchCandidate || obj.nearLiquidation || false),
    blocker: inferBlocker(obj),
  };
}

function collectLocalArtifactRows() {
  const rows = [];
  for (const source of LOCAL_ARTIFACTS) {
    const full = path.join(WORKSPACE, source.file);
    const json = readJson(full, null);
    if (!json) continue;
    rows.push(...collectObjects(json).map((obj) => toLocalRow(source, obj)));
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.protocol}:${row.chain}:${row.label}:${row.side}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || (asNumber(b.routeLiquidityUsd) || 0) - (asNumber(a.routeLiquidityUsd) || 0) || (asNumber(b.contextUsd) || 0) - (asNumber(a.contextUsd) || 0));
}

async function fetchDexRows() {
  try {
    const tokens = [...ADAPTER_TOKENS, ...EXTRA_CONTEXT_TOKENS].map((row) => row.token);
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${tokens.join(",")}`, 30_000);
    const wanted = new Map([...ADAPTER_TOKENS, ...EXTRA_CONTEXT_TOKENS].map((row) => [row.token.toLowerCase(), row]));
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
    return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 30);
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
      RWA_NAV_SYMBOL_FILTER: "XAUt",
      RWA_NAV_CHAIN_IDS: "1,43114,42161,42220,57073,56",
      RWA_NAV_OUT: "reports/raw/fast/tether-gold-phase0.json",
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
  const tokenTable = out.tokenRows.map((row) => `| ${row.chain} | ${shortAddress(row.address)} | ${row.codePresent} | ${row.symbol || "n/a"} | ${row.totalSupply || "n/a"} | ${formatUsd(row.tokenPriceUsd)} | ${row.erc4626?.navUsdPerShare ? formatUsd(row.erc4626.navUsdPerShare) : "n/a"} | ${row.currentAnomaly} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const matchTable = out.topMatches.slice(0, 10).map((row) => `| ${row.protocol} | ${row.side} | ${row.producer?.chain || "n/a"} | ${row.producer?.symbol || "?"} | ${row.reviewCandidate} | ${row.watchCandidate} | ${formatUsd(row.market?.otherReserveCashUsd ?? row.market?.cashUsd ?? row.market?.baseCashUsd ?? row.market?.liquidityAssetsUsd ?? row.market?.oppositeLiquidityUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const localTable = out.localArtifactRows.slice(0, 12).map((row) => `| ${row.protocol} | ${row.chain} | ${row.label} | ${row.side} | ${row.ltv} | ${formatUsd(row.routeLiquidityUsd)} | ${formatUsd(row.contextUsd)} | ${formatBps(row.anomalyBps)} | ${row.routePositive} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const dexTable = out.dexLiquidityRows.slice(0, 10).map((row) => `| ${row.chain} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} | ${row.priceUsd ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";

  const content = `# 🟢 DORMANT — Tether Gold Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-tether-gold-phase0.js\`

Artifact: \`reports/raw/fast/tether-gold-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass resolved XAUt adapter tokens, ran the generic RWA/NAV producer-to-consumer graph, joined prior local XAUt consumer artifacts, sampled public DEX context, and checked for current NAV/reference anomalies. Current gates remain closed because XAUt rows do not combine attacker-favorable accepted-value divergence with exact acquisition, borrow/liquidation/redemption, exit liquidity, and fork proof.

## Summary

| Metric | Value |
|---|---:|
| DeFiLlama TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum TVL | ${formatUsd(s.ethereumTvlUsd)} |
| Avalanche TVL | ${formatUsd(s.avalancheTvlUsd)} |
| Arbitrum TVL | ${formatUsd(s.arbitrumTvlUsd)} |
| Celo TVL | ${formatUsd(s.celoTvlUsd)} |
| Ink TVL | ${formatUsd(s.inkTvlUsd)} |
| Token rows | \`${s.tokenRows}\` |
| Token rows with code | \`${s.tokenRowsWithCode}\` |
| Consumer graph matches | \`${s.matches}\` |
| Local artifact XAUt rows | \`${s.localArtifactRows}\` |
| Fluid XAUt vault rows | \`${s.fluidXautVaultRows}\` |
| Fluid XAUt borrowable USD | ${formatUsd(s.fluidXautBorrowableUsd)} |
| Compound XAUt rows | \`${s.compoundXautRows}\` |
| Euler XAUt rows | \`${s.eulerXautRows}\` |
| Aave V4 XAUt rows | \`${s.aaveV4XautRows}\` |
| Lista XAUt rows | \`${s.listaXautRows}\` |
| Review candidates | \`${s.reviewCandidates}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Top DEX liquidity | ${formatUsd(s.topDexLiquidityUsd)} |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |

## XAUt Tokens

| Chain | Token | Code | Symbol | Total supply | Public token price | ERC4626 NAV/share | Current anomaly |
|---|---|---:|---|---:|---:|---:|---:|
${tokenTable}

## Generic Consumer Matches

| Protocol | Side | Producer chain | Symbol | Review | Watch | Route-side liquidity |
|---|---|---|---|---:|---:|---:|
${matchTable}

## Local Artifact Joins

| Protocol | Chain | Label | Side | CF/LT or LTV | Route liquidity | Context USD | Anomaly | Route-positive |
|---|---|---|---|---:|---:|---:|---:|---:|
${localTable}

## DEX Context

| Chain | DEX | Pair | Liquidity USD | 24h volume USD | Price USD |
|---|---|---|---:|---:|---:|
${dexTable}

## Adapter Caveats

- Monad and Plasma adapter rows are recorded as non-local-RPC context only in this pass.
- The Polygon adapter row resolves through \`ADDRESSES.flow.stgUSDC\`; it is excluded from exact XAUt seed scanning until token identity is verified on-chain.
- BNB Chain XAUt appears through local Lista DEX artifacts but is not part of the current DeFiLlama Tether Gold adapter chain list.

## Blockers

- XAUt redemption/custody remains treated as permissioned; no public atomic redeem path is proven.
- No ERC4626-style NAV interface or current NAV/reference anomaly is resolved for exact XAUt token rows in the generic graph.
- Fluid XAUt vaults have material stable borrow liquidity, but CF/LT haircuts and oracle state do not show a current accepted-value overpricing route, and no borrower-level exact liquidation/fork proof is present.
- Compound/Euler/Aave/Lista rows are context or blocked by no high-CF watch, zero/low borrow use, dust debt, low borrow liquidity, or missing exact acquisition/exit economics.
- Public DEX liquidity is context only; no exact positive borrow, redemption, liquidation, or unwind route is proven.
- No fork extraction proof and no signed-action justification exist.

## Required For Route-Positive

- XAUt must be accepted by a material lending, margin, redemption, or liquidation consumer with a permissionless value-changing trigger.
- Accepted value must diverge from exact acquisition, NAV, redemption, or DEX exit value in an attacker-favorable direction after CF/LLTV haircuts.
- Borrowed, redeemed, or seized assets must have exact positive exit economics after gas, fees, slippage, and permission constraints.
- Fork extraction proof must show measured profit.

## Next Read-Only Step

Keep XAUt on RWA/NAV and Fluid/Compound/Aave consumer watch. Reopen for exact quoting only if a material XAUt borrower becomes liquidatable, a trusted oracle/accepted-value divergence clears the collateral haircut, or a permissionless redemption/DEX exit path becomes exact-positive after costs.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const consumerGraph = runConsumerGraph();
  const [metadataRaw, dexLiquidityRows] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/tether-gold", 45_000).catch(() => ({})),
    fetchDexRows(),
  ]);
  if (!consumerGraph) throw new Error("Missing consumer graph artifact after child scan");

  const localArtifactRows = collectLocalArtifactRows();
  const tokenRows = flattenResults(consumerGraph, "topProducers").filter((row) => String(row.symbol || "").toLowerCase() === "xaut" || TOKEN_SET.has(String(row.address || "").toLowerCase()));
  const topMatches = flattenResults(consumerGraph, "topMatches");
  const latestTvl = latestRow(metadataRaw.tvl)?.totalLiquidityUSD ?? Object.values(metadataRaw.currentChainTvls || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const ethData = chainData(metadataRaw, "Ethereum");
  const avaxData = chainData(metadataRaw, "Avalanche");
  const arbData = chainData(metadataRaw, "Arbitrum");
  const celoData = chainData(metadataRaw, "Celo");
  const inkData = chainData(metadataRaw, "Ink");
  const routePositive = (asNumber(consumerGraph.summary?.routePositive) || 0) + localArtifactRows.filter((row) => row.routePositive).length;
  const graphWatchCandidates = asNumber(consumerGraph.summary?.watchCandidates) || 0;
  const localWatchCandidates = localArtifactRows.filter((row) => row.routePositive || (row.watchCandidate && (asNumber(row.routeLiquidityUsd) || 0) >= 10_000 && Math.abs(asNumber(row.anomalyBps) || 0) >= 100)).length;
  const watchCandidates = graphWatchCandidates + localWatchCandidates;
  const fluidRows = localArtifactRows.filter((row) => row.protocol === "Fluid Lending" || row.protocol === "Fluid DEX");
  const fluidVaultRows = fluidRows.filter((row) => /VaultT/i.test(row.label));

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-tether-gold-phase0.js",
    scope: "Tether Gold public Phase 0 XAUt token, RWA/NAV consumer graph, local artifact joins, and exit-liquidity triage",
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
      name: metadataRaw.name || "Tether Gold",
      slug: metadataRaw.slug || "tether-gold",
      category: metadataRaw.category || "RWA",
      chains: metadataRaw.chains || ["Ethereum", "Monad", "Plasma", "Avalanche", "Arbitrum", "Celo", "Polygon", "Ink"],
      module: metadataRaw.module || "tether-gold/index.js",
      tvlCodePath: metadataRaw.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/tether-gold/index.js",
      methodology: metadataRaw.methodology || "TVL corresponds to the total amount of XAUt minted",
      adapterTokens: ADAPTER_TOKENS,
      extraContextTokens: EXTRA_CONTEXT_TOKENS,
      nonRpcOrAdapterContext: NON_RPC_OR_ADAPTER_CONTEXT,
    },
    tokenRows,
    dexLiquidityRows,
    topMatches,
    localArtifactRows,
    consumerGraph,
    summary: {
      defillamaCurrentTvlUsd: round(latestTvl, 2),
      ethereumTvlUsd: round(ethData.tvlUsd, 2),
      avalancheTvlUsd: round(avaxData.tvlUsd, 2),
      arbitrumTvlUsd: round(arbData.tvlUsd, 2),
      celoTvlUsd: round(celoData.tvlUsd, 2),
      inkTvlUsd: round(inkData.tvlUsd, 2),
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
      fluidXautVaultRows: fluidVaultRows.length,
      fluidXautBorrowableUsd: round(fluidRows.reduce((sum, row) => sum + (asNumber(row.routeLiquidityUsd) || 0), 0), 2),
      compoundXautRows: localArtifactRows.filter((row) => row.protocol === "Compound V3").length,
      eulerXautRows: localArtifactRows.filter((row) => row.protocol === "Euler V2").length,
      aaveV4XautRows: localArtifactRows.filter((row) => row.protocol === "Aave V4").length,
      listaXautRows: localArtifactRows.filter((row) => row.protocol === "Lista DEX").length,
      reviewCandidates: (asNumber(consumerGraph.summary?.reviewCandidates) || 0) + localArtifactRows.filter((row) => (asNumber(row.routeLiquidityUsd) || 0) >= 10_000 || (asNumber(row.contextUsd) || 0) >= 10_000).length,
      watchCandidates,
      dexLiquidityRows: dexLiquidityRows.length,
      topDexLiquidityUsd: round(dexLiquidityRows[0]?.liquidityUsd, 2),
      routePositive,
      executableNow: false,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      status: routePositive > 0 ? "tether-gold-route-positive-needs-proof" : watchCandidates > 0 ? "tether-gold-watch-needs-nav-consumer-economics" : "tether-gold-phase0-no-route-positive",
    },
    blockers: [
      "No XAUt consumer-side borrow/liquidation/redeem route with current accepted-value divergence and material exact-positive economics was found",
      "No ERC4626 NAV interface or current NAV/reference divergence above threshold was resolved for exact XAUt producer rows",
      "XAUt redemption/custody and transferability remain treated as permissioned/restricted absent public atomic exit proof",
      "Fluid, Compound, Euler, Aave, Lista, and DEX rows remain context-only or blocked by collateral haircuts, low/dust liquidity, non-watch source classification, or missing exact exit economics",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "XAUt accepted by a material lending, margin, redemption, or liquidation consumer",
      "permissionless NAV/oracle/backing/accepted-value divergence or current liquidatable borrower condition",
      "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs",
      "fork extraction proof",
    ],
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, null, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Tether Gold Phase0: tvl=${formatUsd(output.summary.defillamaCurrentTvlUsd)} tokens=${output.summary.tokenRows} matches=${output.summary.matches} localRows=${output.summary.localArtifactRows} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 1000));
  process.exit(1);
});
