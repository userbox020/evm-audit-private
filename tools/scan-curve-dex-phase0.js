#!/usr/bin/env node
// scan-curve-dex-phase0.js - bounded read-only Phase 0 for Curve pool/LP/gauge consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "curve-dex-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "curve-dex-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const RPC_CONCURRENCY = Number(process.env.CURVE_DEX_RPC_CONCURRENCY || "8");
const MIN_MATERIAL_POOL_TVL_USD = Number(process.env.CURVE_DEX_MIN_MATERIAL_POOL_TVL_USD || "100000");
const MIN_WATCH_POOL_TVL_USD = Number(process.env.CURVE_DEX_MIN_WATCH_POOL_TVL_USD || "250000");
const MAX_CONTEXT_POOLS_PER_CHAIN = Number(process.env.CURVE_DEX_MAX_CONTEXT_POOLS_PER_CHAIN || "10");
const REGISTRIES = ["main", "factory", "factory-stable-ng", "crypto", "factory-crypto", "factory-twocrypto", "factory-tricrypto"];

const CHAINS = {
  1: { name: "Ethereum", llamaNames: ["Ethereum"], curveApi: "ethereum" },
  42161: { name: "Arbitrum", llamaNames: ["Arbitrum"], curveApi: "arbitrum" },
  8453: { name: "Base", llamaNames: ["Base"], curveApi: "base" },
  137: { name: "Polygon", llamaNames: ["Polygon"], curveApi: "polygon" },
  43114: { name: "Avalanche", llamaNames: ["Avalanche"], curveApi: "avalanche" },
  10: { name: "Optimism", llamaNames: ["Optimism"], curveApi: "optimism" },
  56: { name: "BNB Chain", llamaNames: ["Binance", "BSC", "BNB"], curveApi: "bsc" },
  42220: { name: "Celo", llamaNames: ["Celo"], curveApi: "celo" },
  146: { name: "Sonic", llamaNames: ["Sonic"], curveApi: "sonic" },
  5000: { name: "Mantle", llamaNames: ["Mantle"], curveApi: "mantle" },
  999: { name: "Hyperliquid L1", llamaNames: ["Hyperliquid L1"], curveApi: "hyperliquid", custom: true },
};

const UNSUPPORTED_PROTOCOL_CHAINS = ["Fraxtal", "Etherlink", "Monad", "Plasma", "X Layer", "TAC", "Ink"];
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";

const CONSUMER_ARTIFACTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["seven-chain-lending", "reports/raw/fast/seven-chain-lending-coverage.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["small-cap-oracle", "reports/raw/fast/small-cap-oracle-manipulation-routes.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["evault-collateral-nav", "reports/raw/fast/evault-collateral-nav-manipulation.json"],
  ["focused-morpho", "reports/raw/fast/focused-morpho-review-producers.json"],
  ["focused-euler", "reports/raw/fast/focused-euler-evk-review-producers.json"],
  ["morpho-public-allocator", "reports/raw/fast/morpho-public-allocator-force-feed.json"],
  ["pool-share-snapshot", "reports/raw/fast/pool-share-snapshot-drift.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
  ["curve-ib-stable", "reports/raw/fast/curve-ib-stable-wrapper-route.json"],
];

const DIRECT_SOURCE_SET = new Set([
  "aave-euler-silo", "consumer-first-high-ltv", "seven-chain-lending", "stablecoin-depeg", "small-cap-oracle", "erc4626-consumer", "evault-collateral-nav", "focused-morpho", "focused-euler", "morpho-public-allocator", "pool-share-snapshot", "public-lead-consumer",
]);
const DIRECT_ROLES = new Set(["curvePool", "curveLpToken", "curveGauge"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
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

function safeText(value, max = 140) {
  return String(value || "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-curve-dex-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

function discoveryRows() {
  const d = readJson(PUBLIC_TARGETS, {});
  return [
    ...(d.phase0Queue || []), ...(d.consumerJoinFirst || []), ...(d.protocolCandidates || []), ...(d.targetedRefreshQueue || []), ...(d.yieldCandidates || []), ...(d.targets || []), ...(d.value || []),
  ];
}

function protocolMetadata() {
  const row = discoveryRows().find((p) => p?.slug === "curve-dex" || p?.name === "Curve DEX");
  if (row) return { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], evmChains: row.evmChains || [], customSupportedChains: row.customSupportedChains || [], tvlUsd: round(row.tvlUsd, 2), change1dPct: row.change1dPct ?? null, change7dPct: row.change7dPct ?? null, routePriority: row.routePriority || null, source: "public-audit-target-discovery" };
  return { name: "Curve DEX", slug: "curve-dex", category: "Dexs", chains: Object.values(CHAINS).map((c) => c.name), tvlUsd: null };
}

function curveYieldRows() {
  return discoveryRows()
    .filter((row) => row?.kind === "yield" && row?.project === "curve-dex")
    .map((row) => ({ chain: row.chain, symbol: safeText(row.symbol, 80), tvlUsd: round(row.tvlUsd, 2), apyPct: round(row.apyPct ?? row.apy, 4), poolId: safeText(row.pool, 90), underlying: (row.underlying || row.underlyingTokens || []).map(normalizeAddress).filter(Boolean), routePositive: false }));
}

function curvePoolRow(chainId, registry, p) {
  const cfg = CHAINS[chainId];
  const pool = normalizeAddress(p.address);
  if (!cfg || !pool) return null;
  const lpToken = normalizeAddress(p.lpTokenAddress) || pool;
  const gauge = normalizeAddress(p.gaugeAddress);
  const coins = [...(p.coins || []), ...(p.underlyingCoins || [])]
    .map((coin, index) => ({
      index,
      address: normalizeAddress(coin.address),
      symbol: safeText(coin.symbol, 32),
      name: safeText(coin.name, 80),
      decimals: Number(coin.decimals ?? 18),
      usdPrice: round(coin.usdPrice, 8),
      isBasePoolLpToken: Boolean(coin.isBasePoolLpToken),
    }))
    .filter((coin) => coin.address);
  const tvl = round(p.usdTotal || p.usdTotalExcludingBasePool, 2);
  return {
    chainId: Number(chainId),
    chain: cfg.name,
    curveApi: cfg.curveApi,
    registry,
    id: safeText(p.id, 120),
    name: safeText(p.name || p.symbol, 120),
    symbol: safeText(p.symbol || p.name, 80),
    pool,
    lpToken,
    gauge: gauge && lowerAddress(gauge) !== ZERO ? gauge : null,
    implementation: normalizeAddress(p.implementationAddress),
    coins,
    coinCount: coins.length,
    usdTotal: tvl,
    usdTotalExcludingBasePool: round(p.usdTotalExcludingBasePool, 2),
    virtualPrice: round(p.virtualPrice, 12),
    totalSupply: safeText(p.totalSupply, 80),
    isBroken: Boolean(p.isBroken),
    isMetaPool: Boolean(p.isMetaPool),
    usesRateOracle: Boolean(p.usesRateOracle),
    assetTypeName: safeText(p.assetTypeName, 80),
    material: (asNumber(tvl) || 0) >= MIN_MATERIAL_POOL_TVL_USD,
    routePositive: false,
  };
}

async function fetchChainPools(chainId) {
  const cfg = CHAINS[chainId];
  const registryRows = [];
  const poolRows = [];
  for (const registry of REGISTRIES) {
    const url = `https://api.curve.fi/v1/getPools/${cfg.curveApi}/${registry}`;
    const json = await fetchJson(url, 30_000);
    const rows = (json?.data?.poolData || []).map((p) => curvePoolRow(chainId, registry, p)).filter(Boolean);
    registryRows.push({ chainId: Number(chainId), chain: cfg.name, curveApi: cfg.curveApi, registry, apiOk: Boolean(json), poolsAvailable: rows.length, materialPools: rows.filter((row) => row.material).length });
    poolRows.push(...rows);
  }
  const deduped = new Map();
  for (const row of poolRows) {
    const key = lowerAddress(row.pool) || `${row.chainId}:${row.id}`;
    const existing = deduped.get(key);
    if (!existing || (asNumber(row.usdTotal) || 0) > (asNumber(existing.usdTotal) || 0)) deduped.set(key, row);
  }
  return { registryRows, poolRows: [...deduped.values()] };
}

function selectPools(allPools, yieldRows) {
  const yieldIds = new Set(yieldRows.map((row) => String(row.poolId || "").toLowerCase()).filter(Boolean));
  const selected = [];
  const byChain = new Map();
  for (const row of allPools) {
    if (!byChain.has(row.chainId)) byChain.set(row.chainId, []);
    byChain.get(row.chainId).push(row);
  }
  for (const rows of byChain.values()) {
    rows.sort((a, b) => (asNumber(b.usdTotal) || 0) - (asNumber(a.usdTotal) || 0));
    for (const row of rows) {
      const yieldMatched = yieldIds.has(String(row.id || "").toLowerCase());
      if (row.material || yieldMatched || selected.filter((r) => r.chainId === row.chainId).length < MAX_CONTEXT_POOLS_PER_CHAIN) selected.push({ ...row, yieldMatched });
    }
  }
  const seen = new Set();
  return selected.filter((row) => {
    const key = `${row.chainId}:${lowerAddress(row.pool)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (asNumber(b.usdTotal) || 0) - (asNumber(a.usdTotal) || 0));
}

async function attachCodePresence(poolRows, rpcs) {
  return await mapLimit(poolRows, RPC_CONCURRENCY, async (row) => {
    const rpc = rpcs[row.chainId];
    const [poolCode, lpCode, gaugeCode] = await Promise.all([
      getCode(rpc, row.pool), getCode(rpc, row.lpToken), row.gauge ? getCode(rpc, row.gauge) : Promise.resolve("0x"),
    ]);
    return {
      ...row,
      rpcAvailable: Boolean(rpc),
      poolCodePresent: Boolean(poolCode && poolCode !== "0x"),
      lpTokenCodePresent: Boolean(lpCode && lpCode !== "0x"),
      gaugeCodePresent: Boolean(gaugeCode && gaugeCode !== "0x"),
      poolCodeBytes: poolCode && poolCode !== "0x" ? strip0x(poolCode).length / 2 : 0,
      lpTokenCodeBytes: lpCode && lpCode !== "0x" ? strip0x(lpCode).length / 2 : 0,
      gaugeCodeBytes: gaugeCode && gaugeCode !== "0x" ? strip0x(gaugeCode).length / 2 : 0,
    };
  });
}

function primitiveAddresses(value, out = new Set()) {
  if (typeof value === "string") {
    for (const m of value.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0].toLowerCase());
  } else if (Array.isArray(value)) {
    for (const item of value) primitiveAddresses(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) primitiveAddresses(item, out);
  }
  return out;
}

function summarizeContext(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "project", "name", "chain", "chainId", "surface", "side", "symbol", "asset", "token", "collateral", "borrowAsset", "loanAsset", "oracle", "source", "status", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "borrowAssetsUsd", "supplyAssetsUsd", "file", "rootFile"];
  const out = {};
  for (const field of fields) {
    const value = obj[field];
    if (value === undefined) continue;
    if (typeof value === "object") out[field] = safeText(JSON.stringify(value), 180);
    else out[field] = safeText(value, 180);
  }
  return out;
}

function scanObjectForAddresses(source, obj, addressRoles, out, depth = 0) {
  if (!obj || depth > 9 || out.length >= 900) return;
  if (Array.isArray(obj)) {
    for (const item of obj) scanObjectForAddresses(source, item, addressRoles, out, depth + 1);
    return;
  }
  if (typeof obj !== "object") return;
  const addrs = primitiveAddresses(obj);
  const hits = [...addrs].filter((addr) => addressRoles[addr]);
  if (hits.length) {
    const roles = unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.role)));
    out.push({
      source,
      hitRoles: roles,
      hitAddresses: hits.slice(0, 16),
      pools: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.pool)).filter(Boolean)).slice(0, 12),
      context: summarizeContext(obj),
      directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)),
      routePositive: false,
      blocker: "Local artifact address match is context only unless the Curve pool/LP/gauge itself is consumed by oracle/collateral logic with exact positive economics",
    });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(poolRows) {
  const roles = {};
  function add(addr, role, pool, chain, symbol) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push({ role, pool, chain, symbol });
  }
  for (const row of poolRows) {
    add(row.pool, "curvePool", row.pool, row.chain, row.symbol);
    add(row.lpToken, "curveLpToken", row.pool, row.chain, row.symbol);
    add(row.gauge, "curveGauge", row.pool, row.chain, row.symbol);
    add(row.implementation, "implementation", row.pool, row.chain, row.symbol);
    for (const coin of row.coins || []) add(coin.address, "coin", row.pool, row.chain, row.symbol);
  }
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) {
    const json = readJson(path.join(WORKSPACE, rel), null);
    if (!json) continue;
    scanObjectForAddresses(source, json, roles, matches);
  }
  return { matches, directConsumerRows: matches.filter((row) => row.directConsumer), tokenContextRows: matches.filter((row) => !row.directConsumer) };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const chainTable = artifact.chainRows.map((row) => `| ${row.chain} | ${row.curveApi} | ${row.rpcAvailable ? "yes" : "no"} | ${row.poolsAvailable} | ${row.materialPools} | ${row.selectedPools} |`).join("\n");
  const topPools = artifact.poolRows.slice(0, 12);
  const poolTable = topPools.length ? topPools.map((row) => `| ${row.chain} | ${compactAddress(row.pool)} | ${compactAddress(row.lpToken)} | ${row.symbol || row.name || "n/a"} | ${formatUsd(row.usdTotal)} | ${row.registry} | ${row.coinCount} | ${row.usesRateOracle ? "yes" : "no"} |`).join("\n") : "| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const yieldTable = artifact.yieldRows.length ? artifact.yieldRows.slice(0, 8).map((row) => `| ${row.chain} | ${row.symbol || "n/a"} | ${formatUsd(row.tvlUsd)} | ${row.apyPct ?? "n/a"} | ${row.underlying.map(compactAddress).join(", ") || "n/a"} |`).join("\n") : "| none | n/a | n/a | n/a | n/a |";
  const consumerTable = artifact.directConsumerRows.length ? artifact.directConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.pools.map(compactAddress).join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Curve pool/LP/gauge address was found in consumer-grade artifacts |";

  return `# ${SIGNAL_DORMANT} - Curve DEX Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. Curve API pools, selected material pools, LP/gauge addresses, rate-oracle context, and local consumer joins were mapped across configured chains. Coin-level matches and DEX-exit quote usage are context only; route-positive requires a trusted consumer that prices a Curve pool/LP/gauge path plus exact positive manipulation, borrow/redeem/liquidation, and exit economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Chains queried | ${s.chainsQueried} |
| Chains with RPC | ${s.chainsWithRpc.length} |
| Unsupported protocol chains | ${artifact.unsupportedProtocolChains.join(", ") || "none"} |
| API pools available | ${s.poolsAvailable} |
| Pools selected | ${s.poolsSelected} |
| Material pools | ${s.materialPoolRows} |
| Pools with gauges | ${s.gaugeRows} |
| Pools using rate oracle | ${s.usesRateOracleRows} |
| Public yield rows | ${s.publicYieldRows} |
| Direct consumer rows | ${s.directConsumerRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |

## Chains

| Chain | Curve API | RPC | API pools | Material | Selected |
|---|---|---|---:|---:|---:|
${chainTable}

## Top Selected Pools

| Chain | Pool | LP token | Symbol | TVL | Registry | Coins | Rate oracle |
|---|---|---|---|---:|---|---:|---|
${poolTable}

## Public Yield Rows

| Chain | Symbol | TVL | APY % | Underlying |
|---|---|---:|---:|---|
${yieldTable}

## Direct Consumer Join

| Source | Hit roles | Addresses | Pools | Context |
|---|---|---|---|---|
${consumerTable}

## Blockers

- No Curve pool/LP/gauge address is currently found as value-bearing collateral, reserve asset, or oracle-specific consumer in scanned consumer-grade artifacts.
- Coin-level joins are dominated by common assets and DEX-exit quote usage.
- Curve pool TVL, APY, virtual price, and rate-oracle context are not impact without a consumer that trusts the pool/LP/gauge value.
- Curve spot/EMA/virtual-price manipulation is not impact without exact consumer linkage and positive manipulation economics.
- No fork extraction proof exists.

## Required For Route-Positive

- A deployed lending, vault, margin, or oracle consumer references a Curve pool, LP token, gauge, or pool oracle path.
- The referenced Curve state is permissionlessly movable or stale in an attacker-favorable direction.
- Borrow, redemption, liquidation, or settlement liquidity is material and exact-quoted after fees, gas, and slippage.
- Fork extraction proof shows positive net value.

Artifacts: \`reports/raw/fast/curve-dex-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const yieldRows = curveYieldRows();
  const chainIds = Object.keys(CHAINS).map(Number);
  const rpcs = await resolveRpcPool(chainIds);
  const chainRows = [];
  const registryRows = [];
  const allPools = [];

  for (const chainId of chainIds) {
    const cfg = CHAINS[chainId];
    const fetched = await fetchChainPools(chainId);
    registryRows.push(...fetched.registryRows);
    allPools.push(...fetched.poolRows);
    chainRows.push({ chainId, chain: cfg.name, curveApi: cfg.curveApi, custom: Boolean(cfg.custom), rpcAvailable: Boolean(rpcs[chainId]), poolsAvailable: fetched.poolRows.length, materialPools: fetched.poolRows.filter((row) => row.material).length, selectedPools: 0 });
  }

  const selectedBase = selectPools(allPools, yieldRows);
  const selectedPools = await attachCodePresence(selectedBase, rpcs);
  for (const row of chainRows) row.selectedPools = selectedPools.filter((pool) => pool.chainId === row.chainId).length;

  const joins = localConsumerJoins(selectedPools);
  const directPoolSet = new Set(joins.directConsumerRows.flatMap((row) => row.pools.map(lowerAddress)).filter(Boolean));
  const watchCandidates = selectedPools
    .filter((row) => directPoolSet.has(lowerAddress(row.pool)) && (asNumber(row.usdTotal) || 0) >= MIN_WATCH_POOL_TVL_USD)
    .map((row) => ({ ...row, reason: "Curve pool/LP/gauge address appears in a consumer artifact and has material TVL", routePositive: false }));

  const summary = {
    chainsQueried: chainRows.length,
    chainsWithRpc: chainRows.filter((row) => row.rpcAvailable).map((row) => row.chainId),
    chainsMissingRpc: chainRows.filter((row) => !row.rpcAvailable).map((row) => row.chainId),
    customApiChains: chainRows.filter((row) => row.custom).map((row) => row.chain),
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS.length,
    registryRows: registryRows.length,
    poolsAvailable: allPools.length,
    poolsSelected: selectedPools.length,
    materialPoolRows: selectedPools.filter((row) => row.material).length,
    gaugeRows: selectedPools.filter((row) => row.gauge).length,
    usesRateOracleRows: selectedPools.filter((row) => row.usesRateOracle).length,
    publicYieldRows: yieldRows.length,
    directConsumerRows: joins.directConsumerRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    maxPoolTvlUsd: round(Math.max(0, ...selectedPools.map((row) => asNumber(row.usdTotal) || 0)), 2),
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closedReason: joins.directConsumerRows.length
      ? "Curve consumer references found, but no exact-positive manipulation/borrow/exit economics or fork proof"
      : "no Curve pool/LP/gauge address is referenced by scanned consumer-grade artifacts",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-curve-dex-phase0.js",
    scope: "Read-only Curve DEX pool/LP/gauge and consumer-route Phase 0 scan",
    target: { name: "Curve DEX", slug: "curve-dex", category: "Dexs", surface: "dex-oracle-consumer-only", metadata },
    safety: { publicApisOnlyForMetadata: true, curvePublicApiRead: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    thresholds: { minMaterialPoolTvlUsd: MIN_MATERIAL_POOL_TVL_USD, minWatchPoolTvlUsd: MIN_WATCH_POOL_TVL_USD, maxContextPoolsPerChain: MAX_CONTEXT_POOLS_PER_CHAIN },
    docs: { curveApi: "https://api.curve.fi/v1/getPools/{chain}/{registry}", factorySource: "https://github.com/curvefi/curve-contract" },
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS,
    yieldRows,
    chainRows,
    registryRows,
    poolRows: selectedPools,
    directConsumerRows: joins.directConsumerRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 180),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: [
      "No Curve pool/LP/gauge address is referenced by scanned consumer-grade artifacts",
      "Coin-level matches are common-asset context and not Curve-specific impact",
      "Curve pool TVL, APY, virtual price, and rate-oracle context do not prove accepted-value divergence or extractive consumer economics",
      "No exact positive acquisition/manipulation/borrow/exit economics or fork proof",
    ],
    requiredForRoutePositive: [
      "deployed consumer references a Curve pool, LP token, gauge, or pool oracle path",
      "pool/oracle state is permissionlessly movable or stale in attacker-favorable direction",
      "borrow, redemption, liquidation, or settlement route is exact-quoted and positive",
      "fork extraction proof",
    ],
    nextReadOnlyStep: joins.directConsumerRows.length
      ? "Static-review the matched consumer and exact-quote only if Curve state affects accepted value."
      : "Reopen Curve DEX only if a lending/oracle consumer references a Curve pool/LP/gauge or a new adapter consumes Curve state.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));

  if (!QUIET) console.log(`Curve DEX Phase 0: pools=${summary.poolsSelected} material=${summary.materialPoolRows} directConsumers=${summary.directConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
