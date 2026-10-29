#!/usr/bin/env node
// scan-balancer-v3-phase0.js - bounded read-only Phase 0 for Balancer V3 pool/rate-provider consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "balancer-v3-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "balancer-v3-phase0-triage.md");
const PROTOCOLS = path.join(WORKSPACE, "reports", "raw", "defillama-protocols-full.json");
const TEMP_PROTOCOLS = path.join(WORKSPACE, ".opencode", "temp_protocols.json");
const BALANCER_GQL = "https://api-v3.balancer.fi/graphql";
const QUIET = process.argv.includes("--quiet");

const MAX_POOLS_PER_CHAIN = Number(process.env.BALANCER_V3_MAX_POOLS_PER_CHAIN || "200");
const PAGE_SIZE = Math.min(100, Math.max(10, Number(process.env.BALANCER_V3_PAGE_SIZE || "100")));
const MIN_MATERIAL_POOL_TVL_USD = Number(process.env.BALANCER_V3_MIN_MATERIAL_POOL_TVL_USD || "100000");
const MIN_WATCH_POOL_TVL_USD = Number(process.env.BALANCER_V3_MIN_WATCH_POOL_TVL_USD || "250000");

const CHAINS = {
  MAINNET: { chainId: 1, name: "Ethereum" },
  ARBITRUM: { chainId: 42161, name: "Arbitrum" },
  BASE: { chainId: 8453, name: "Base" },
  AVALANCHE: { chainId: 43114, name: "Avalanche" },
  OPTIMISM: { chainId: 10, name: "Optimism" },
  GNOSIS: { chainId: 100, name: "Gnosis" },
};

const UNSUPPORTED_PROTOCOL_CHAINS = ["Monad", "Hyperliquid L1", "Plasma"];

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
  ["spark-ssr-psm", "reports/raw/fast/spark-ssr-psm-live.json"],
  ["lrt-oracle-drift", "reports/raw/fast/lrt-oracle-drift-routes.json"],
  ["base-syrupusdc", "reports/raw/fast/base-syrupusdc-routes.json"],
  ["base-cadc", "reports/raw/fast/base-cadc-routes.json"],
  ["avalanche-stable-yield", "reports/raw/fast/avalanche-stable-yield-routes.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
  ["hyperliquid-linked", "reports/raw/fast/hyperliquid-linked-token-consumers.json"],
];

const DIRECT_ROLES = new Set(["pool", "hook", "priceRateProvider"]);
const DIRECT_SOURCE_SET = new Set([
  "aave-euler-silo",
  "consumer-first-high-ltv",
  "seven-chain-lending",
  "stablecoin-depeg",
  "small-cap-oracle",
  "erc4626-consumer",
  "evault-collateral-nav",
  "focused-morpho",
  "focused-euler",
  "morpho-public-allocator",
  "spark-ssr-psm",
  "lrt-oracle-drift",
  "base-syrupusdc",
  "base-cadc",
  "avalanche-stable-yield",
  "public-lead-consumer",
  "hyperliquid-linked",
]);
const ZERO = "0x0000000000000000000000000000000000000000";
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }

function asNumber(value) {
  if (value === null || value === undefined) return null;
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

function safeText(value, max = 140) {
  return String(value || "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null;
}

function protocolMetadata() {
  for (const file of [PROTOCOLS, TEMP_PROTOCOLS]) {
    const raw = readJson(file, null);
    const arr = Array.isArray(raw) ? raw : raw?.value || raw?.protocols || [];
    const hit = arr.find((p) => p?.slug === "balancer-v3" || p?.name === "Balancer V3");
    if (hit) {
      return {
        name: hit.name,
        slug: hit.slug,
        category: hit.category,
        chains: hit.chains || [],
        tvlUsd: round(hit.tvl, 2),
        chainTvls: hit.chainTvls || {},
        module: hit.module || null,
        tvlCodePath: hit.tvlCodePath || null,
        url: hit.url || null,
        audits: hit.audits || null,
        auditLinks: hit.audit_links || [],
        description: hit.description || null,
      };
    }
  }
  return { name: "Balancer V3", slug: "balancer-v3", category: "Dexs", chains: Object.values(CHAINS).map((c) => c.name), tvlUsd: null };
}

async function queryBalancer(query, variables = {}) {
  const res = await fetch(BALANCER_GQL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "evm-audit-balancer-v3-phase0/1.0" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`Balancer GraphQL returned non-JSON status ${res.status}`);
  }
  if (!res.ok || json.errors?.length) {
    const msg = json.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Balancer GraphQL error: ${msg}`);
  }
  return json.data || {};
}

function poolQuery() {
  const d = "$";
  return `query(${d}where:GqlPoolFilter,${d}first:Int,${d}skip:Int){
    poolGetPools(where:${d}where,first:${d}first,skip:${d}skip,orderBy:totalLiquidity,orderDirection:desc){
      id address chain protocolVersion type name symbol factory hasErc4626 hasNestedErc4626
      dynamicData{totalLiquidity totalSupply swapEnabled isPaused isInRecoveryMode volume24h fees24h}
      liquidityManagement{enableDonation disableUnbalancedLiquidity enableAddLiquidityCustom enableRemoveLiquidityCustom}
      hook{address type}
      staking{address type}
      poolTokens{address symbol name decimals balance balanceUSD priceRate priceRateProvider isErc4626 hasNestedPool underlyingToken{address symbol decimals}}
    }
  }`;
}

async function fetchPoolsForChain(gqlChain) {
  const rows = [];
  const errors = [];
  for (let skip = 0; skip < MAX_POOLS_PER_CHAIN; skip += PAGE_SIZE) {
    try {
      const data = await queryBalancer(poolQuery(), {
        first: Math.min(PAGE_SIZE, MAX_POOLS_PER_CHAIN - skip),
        skip,
        where: { chainIn: [gqlChain], protocolVersionIn: [3], minTvl: MIN_MATERIAL_POOL_TVL_USD },
      });
      const page = data.poolGetPools || [];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    } catch (err) {
      errors.push({ chain: gqlChain, error: safeText(err?.message || String(err), 220) });
      break;
    }
  }
  return { rows, errors };
}

function normalizePool(raw) {
  const cfg = CHAINS[raw.chain] || { chainId: null, name: raw.chain };
  const tokens = (raw.poolTokens || []).map((token) => ({
    address: normalizeAddress(token.address),
    symbol: safeText(token.symbol, 40),
    name: safeText(token.name, 80),
    decimals: token.decimals === undefined || token.decimals === null ? null : Number(token.decimals),
    balance: round(token.balance, 8),
    balanceUsd: round(token.balanceUSD, 2),
    priceRate: round(token.priceRate, 12),
    priceRateProvider: normalizeAddress(token.priceRateProvider),
    isErc4626: Boolean(token.isErc4626),
    hasNestedPool: Boolean(token.hasNestedPool),
    underlyingToken: token.underlyingToken ? {
      address: normalizeAddress(token.underlyingToken.address),
      symbol: safeText(token.underlyingToken.symbol, 40),
      decimals: token.underlyingToken.decimals === undefined || token.underlyingToken.decimals === null ? null : Number(token.underlyingToken.decimals),
    } : null,
  }));
  const rateProviders = unique(tokens.map((t) => lowerAddress(t.priceRateProvider)).filter((addr) => addr && addr !== ZERO));
  const hookAddress = normalizeAddress(raw.hook?.address);
  const stakingAddress = normalizeAddress(raw.staking?.address);
  const totalLiquidityUsd = round(raw.dynamicData?.totalLiquidity, 2);
  return {
    chainId: cfg.chainId,
    chain: cfg.name,
    gqlChain: raw.chain,
    pool: normalizeAddress(raw.address || raw.id),
    id: safeText(raw.id, 90),
    protocolVersion: raw.protocolVersion,
    type: safeText(raw.type, 60),
    name: safeText(raw.name, 120),
    symbol: safeText(raw.symbol, 80),
    factory: normalizeAddress(raw.factory),
    totalLiquidityUsd,
    totalSupply: round(raw.dynamicData?.totalSupply, 8),
    volume24hUsd: round(raw.dynamicData?.volume24h, 2),
    fees24hUsd: round(raw.dynamicData?.fees24h, 2),
    swapEnabled: Boolean(raw.dynamicData?.swapEnabled),
    isPaused: Boolean(raw.dynamicData?.isPaused),
    isInRecoveryMode: Boolean(raw.dynamicData?.isInRecoveryMode),
    hasErc4626: Boolean(raw.hasErc4626),
    hasNestedErc4626: Boolean(raw.hasNestedErc4626),
    hook: hookAddress ? { address: hookAddress, type: safeText(raw.hook?.type, 60) } : null,
    staking: stakingAddress ? { address: stakingAddress, type: safeText(raw.staking?.type, 60) } : null,
    liquidityManagement: raw.liquidityManagement || null,
    tokens,
    tokenSymbols: tokens.map((t) => t.symbol || compactAddress(t.address)).join("/"),
    tokenCount: tokens.length,
    erc4626TokenCount: tokens.filter((t) => t.isErc4626).length,
    rateProviderCount: rateProviders.length,
    rateProviders,
    donationEnabled: raw.liquidityManagement?.enableDonation === true,
    material: (asNumber(totalLiquidityUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD,
    routePositive: false,
  };
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
  const fields = ["id", "protocol", "project", "name", "chain", "chainId", "surface", "side", "symbol", "asset", "token", "collateral", "borrowAsset", "loanAsset", "oracle", "provider", "source", "status", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "borrowAssetsUsd", "supplyAssetsUsd"];
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
  if (!obj || depth > 9 || out.length >= 600) return;
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
      hitAddresses: hits.slice(0, 12),
      pools: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.pool)).filter(Boolean)).slice(0, 8),
      context: summarizeContext(obj),
      directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)),
      routePositive: false,
      blocker: "Local artifact address match is context only unless Balancer V3 pool, hook, or rate-provider state is consumed by value-bearing oracle/collateral logic with exact positive economics",
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
    add(row.pool, "pool", row.pool, row.chain, row.symbol);
    add(row.factory, "factory", row.pool, row.chain, row.symbol);
    add(row.hook?.address, "hook", row.pool, row.chain, row.symbol);
    add(row.staking?.address, "staking", row.pool, row.chain, row.symbol);
    for (const token of row.tokens || []) {
      add(token.address, "poolToken", row.pool, row.chain, row.symbol);
      add(token.priceRateProvider, "priceRateProvider", row.pool, row.chain, row.symbol);
      add(token.underlyingToken?.address, "underlyingToken", row.pool, row.chain, row.symbol);
    }
  }

  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) {
    const json = readJson(path.join(WORKSPACE, rel), null);
    if (!json) continue;
    scanObjectForAddresses(source, json, roles, matches);
  }
  const directRows = matches.filter((row) => row.directConsumer);
  const tokenContextRows = matches.filter((row) => !row.directConsumer);
  return { matches, directRows, tokenContextRows };
}

function topRows(rows, limit = 12) {
  return [...rows].sort((a, b) => (asNumber(b.totalLiquidityUsd) || 0) - (asNumber(a.totalLiquidityUsd) || 0)).slice(0, limit);
}

function buildReport(artifact) {
  const s = artifact.summary;
  const chainTable = artifact.chainRows.map((row) => `| ${row.chain} | ${row.rpcAvailable ? "yes" : "no"} | ${row.poolsEnumerated} | ${row.materialPools} | ${formatUsd(row.topPoolTvlUsd)} | ${row.graphqlError || "none"} |`).join("\n");
  const poolTable = topRows(artifact.poolRows, 10).map((row) => `| ${row.chain} | ${compactAddress(row.pool)} | ${row.type || "n/a"} | ${row.symbol || row.tokenSymbols || "n/a"} | ${formatUsd(row.totalLiquidityUsd)} | ${row.swapEnabled && !row.isPaused ? "yes" : "no"} | ${row.erc4626TokenCount} | ${row.rateProviderCount} | ${row.hook ? "yes" : "no"} |`).join("\n") || "| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const directTable = artifact.directConsumerRows.length ? artifact.directConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.pools.map(compactAddress).join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Balancer V3 pool, hook, or rate-provider address was found in local consumer artifacts |";
  const watchTable = artifact.watchCandidates.length ? artifact.watchCandidates.slice(0, 8).map((row) => `| ${row.chain} | ${compactAddress(row.pool)} | ${row.symbol || row.tokenSymbols || "n/a"} | ${formatUsd(row.totalLiquidityUsd)} | ${row.reason} |`).join("\n") : "| none | n/a | n/a | n/a | no direct consumer join with exact-positive economics |";

  return `# ${SIGNAL_DORMANT} - Balancer V3 Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. Balancer V3 pools, hooks, ERC4626 pool tokens, and price-rate providers were mapped from the public Balancer API across RPC-available EVM chains. Direct pool/hook/rate-provider joins are treated as watch-only until a consumer is proven to value collateral, redemption, liquidation, or settlement from manipulable Balancer V3 state with exact positive economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Chains scanned | ${s.chainsScanned} |
| Unsupported protocol chains | ${artifact.unsupportedProtocolChains.join(", ") || "none"} |
| Pools enumerated | ${s.poolsEnumerated} |
| Material pools | ${s.materialPoolRows} |
| Active material pools | ${s.activeMaterialPoolRows} |
| ERC4626 token rows | ${s.erc4626TokenRows} |
| Price-rate provider rows | ${s.rateProviderRows} |
| Hook-enabled pools | ${s.hookEnabledRows} |
| Donation-enabled pools | ${s.donationEnabledRows} |
| Direct consumer rows | ${s.directConsumerRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |

## Chains

| Chain | RPC | Pools | Material | Top pool TVL | GraphQL error |
|---|---|---:|---:|---:|---|
${chainTable}

## Top Pools

| Chain | Pool | Type | Symbol | Pool TVL | Active | ERC4626 tokens | Rate providers | Hook |
|---|---|---|---|---:|---|---:|---:|---|
${poolTable}

## Direct Consumer Join

| Source | Hit roles | Addresses | Pools | Context |
|---|---|---|---|---|
${directTable}

## Watch Candidates

| Chain | Pool | Symbol | Pool TVL | Reason |
|---|---|---|---:|---|
${watchTable}

## Blockers

- Token-level overlaps are common-asset context unless a consumer prices the Balancer pool/BPT/rate-provider path directly.
- Balancer hooks and ERC4626 rate providers need static or read-only proof that attacker-controlled state can move accepted value.
- Donation-enabled or unbalanced-liquidity flags are not impact without a value-bearing external consumer and exact manipulation cost.
- No exact acquisition, manipulation, borrow/redeem/liquidation, and exit economics are positive.
- No fork extraction proof exists.

## Required For Route-Positive

- A deployed lending, vault, margin, oracle, or settlement consumer references a Balancer V3 pool, hook, BPT, or rate provider.
- The referenced Balancer V3 state is permissionlessly movable, stale, or donation/rounding-sensitive in an attacker-favorable direction.
- Borrow, redemption, liquidation, or settlement liquidity is material and exact-quoted after fees, gas, and slippage.
- Fork extraction proof shows positive net value.

Artifacts: \`reports/raw/fast/balancer-v3-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const chainIds = Object.values(CHAINS).map((c) => c.chainId);
  const rpcs = await resolveRpcPool(chainIds);
  const chainRows = [];
  const poolRows = [];
  const graphqlErrors = [];

  for (const [gqlChain, cfg] of Object.entries(CHAINS)) {
    const rpcAvailable = Boolean(rpcs[cfg.chainId]);
    if (!rpcAvailable) {
      chainRows.push({ chain: cfg.name, chainId: cfg.chainId, gqlChain, rpcAvailable, poolsEnumerated: 0, materialPools: 0, topPoolTvlUsd: null, graphqlError: "noRpcForChain" });
      continue;
    }
    const { rows, errors } = await fetchPoolsForChain(gqlChain);
    graphqlErrors.push(...errors);
    const normalized = rows.map(normalizePool).filter((row) => row.pool);
    poolRows.push(...normalized);
    chainRows.push({
      chain: cfg.name,
      chainId: cfg.chainId,
      gqlChain,
      rpcAvailable,
      poolsEnumerated: normalized.length,
      materialPools: normalized.filter((row) => (asNumber(row.totalLiquidityUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD).length,
      topPoolTvlUsd: round(Math.max(0, ...normalized.map((row) => asNumber(row.totalLiquidityUsd) || 0)), 2),
      graphqlError: errors.map((e) => e.error).join("; ") || null,
    });
  }

  poolRows.sort((a, b) => (asNumber(b.totalLiquidityUsd) || 0) - (asNumber(a.totalLiquidityUsd) || 0));
  const joins = localConsumerJoins(poolRows);
  const directPoolSet = new Set(joins.directRows.flatMap((row) => row.pools.map(lowerAddress)).filter(Boolean));
  const watchCandidates = poolRows
    .filter((row) => directPoolSet.has(lowerAddress(row.pool)) && (asNumber(row.totalLiquidityUsd) || 0) >= MIN_WATCH_POOL_TVL_USD)
    .map((row) => ({ ...row, reason: "Balancer V3 pool/hook/rate-provider address appears in a consumer artifact and pool TVL is material", routePositive: false }));

  const rateProviderRows = [];
  const erc4626TokenRows = [];
  for (const row of poolRows) {
    for (const token of row.tokens || []) {
      if (lowerAddress(token.priceRateProvider) && lowerAddress(token.priceRateProvider) !== ZERO) {
        rateProviderRows.push({ chain: row.chain, pool: row.pool, token: token.address, symbol: token.symbol, priceRateProvider: token.priceRateProvider, poolTvlUsd: row.totalLiquidityUsd });
      }
      if (token.isErc4626) {
        erc4626TokenRows.push({ chain: row.chain, pool: row.pool, token: token.address, symbol: token.symbol, underlyingToken: token.underlyingToken, poolTvlUsd: row.totalLiquidityUsd });
      }
    }
  }

  const summary = {
    chainsScanned: chainRows.filter((row) => row.rpcAvailable).length,
    chainsWithRpc: chainRows.filter((row) => row.rpcAvailable).map((row) => row.chainId),
    chainsMissingRpc: chainRows.filter((row) => !row.rpcAvailable).map((row) => row.chainId),
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS.length,
    poolsEnumerated: poolRows.length,
    materialPoolRows: poolRows.filter((row) => (asNumber(row.totalLiquidityUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD).length,
    activeMaterialPoolRows: poolRows.filter((row) => (asNumber(row.totalLiquidityUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD && row.swapEnabled && !row.isPaused && !row.isInRecoveryMode).length,
    erc4626TokenRows: erc4626TokenRows.length,
    rateProviderRows: rateProviderRows.length,
    hookEnabledRows: poolRows.filter((row) => row.hook).length,
    donationEnabledRows: poolRows.filter((row) => row.donationEnabled).length,
    directConsumerRows: joins.directRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    maxPoolTvlUsd: round(Math.max(0, ...poolRows.map((row) => asNumber(row.totalLiquidityUsd) || 0)), 2),
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closedReason: watchCandidates.length
      ? "Balancer V3 consumer joins found, but no exact-positive manipulation/borrow/exit economics or fork proof"
      : "no Balancer V3 pool, hook, or rate-provider address is proven as a value-bearing consumer route",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-balancer-v3-phase0.js",
    scope: "Read-only Balancer V3 pool/rate-provider and consumer-route Phase 0 scan",
    target: {
      name: "Balancer V3",
      slug: "balancer-v3",
      category: "Dexs",
      surface: "dex-oracle-consumer-only",
      metadata,
    },
    safety: {
      publicApisOnlyForMetadata: true,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: {
      maxPoolsPerChain: MAX_POOLS_PER_CHAIN,
      minMaterialPoolTvlUsd: MIN_MATERIAL_POOL_TVL_USD,
      minWatchPoolTvlUsd: MIN_WATCH_POOL_TVL_USD,
    },
    docs: {
      api: BALANCER_GQL,
      sourceRepo: "https://github.com/balancer/balancer-v3-monorepo",
      docs: "https://docs.balancer.fi/",
      audits: metadata.auditLinks || [],
    },
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS,
    chainRows,
    graphqlErrors,
    poolRows,
    rateProviderRows,
    erc4626TokenRows,
    directConsumerRows: joins.directRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 150),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: [
      "No Balancer V3 pool, hook, or rate-provider match currently has exact-positive manipulation and consumer economics",
      "Token-level matches are common-asset context and not Balancer-specific impact",
      "Donation/unbalanced-liquidity/rate-provider rows need static or fork proof that accepted value moves attacker-favorably",
      "No exact positive acquisition/manipulation/borrow/exit economics or fork proof",
    ],
    requiredForRoutePositive: [
      "deployed consumer references a Balancer V3 pool, BPT, hook, or rate provider",
      "referenced Balancer V3 state is permissionlessly movable, stale, donation-sensitive, or rounding-sensitive",
      "borrow, redemption, liquidation, or settlement route is exact-quoted and positive",
      "fork extraction proof",
    ],
    nextReadOnlyStep: watchCandidates.length
      ? "Static-review matched consumer paths and exact-quote only if Balancer state changes accepted value."
      : "Reopen Balancer V3 only if a consumer references a Balancer pool/hook/rate-provider or a new adapter consumes Balancer V3 state.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));

  if (!QUIET) {
    console.log(`Balancer V3 Phase 0: pools=${summary.poolsEnumerated} material=${summary.materialPoolRows} providers=${summary.rateProviderRows} directConsumers=${summary.directConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
