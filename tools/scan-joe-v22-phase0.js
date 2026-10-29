#!/usr/bin/env node
// scan-joe-v22-phase0.js - bounded read-only Phase 0 for LFJ/Trader Joe Liquidity Book V2.2.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "joe-v22-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "joe-v22-phase0-triage.md");
const PROTOCOLS = path.join(WORKSPACE, "reports", "raw", "defillama-protocols-full.json");
const TEMP_PROTOCOLS = path.join(WORKSPACE, ".opencode", "temp_protocols.json");
const QUIET = process.argv.includes("--quiet");

const MAX_PAIRS_PER_CHAIN = Number(process.env.JOE_V22_MAX_PAIRS_PER_CHAIN || "400");
const RPC_CONCURRENCY = Number(process.env.JOE_V22_RPC_CONCURRENCY || "8");
const MIN_MATERIAL_POOL_TVL_USD = Number(process.env.JOE_V22_MIN_MATERIAL_POOL_TVL_USD || "100000");
const MIN_WATCH_POOL_TVL_USD = Number(process.env.JOE_V22_MIN_WATCH_POOL_TVL_USD || "250000");

const CHAINS = {
  43114: {
    name: "Avalanche",
    slug: "avalanche",
    coinSlug: "avalanche",
    factory: "0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c",
    router: "0x18556DA13313f3532c54711497A8FedAC273220E",
  },
  42161: {
    name: "Arbitrum",
    slug: "arbitrum",
    coinSlug: "arbitrum",
    factory: "0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c",
    router: "0x18556DA13313f3532c54711497A8FedAC273220E",
  },
};

const UNSUPPORTED_PROTOCOL_CHAINS = ["Monad"];

const CONSUMER_ARTIFACTS = [
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["seven-chain-lending", "reports/raw/fast/seven-chain-lending-coverage.json"],
  ["avalanche-stable-yield", "reports/raw/fast/avalanche-stable-yield-routes.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["small-cap-oracle", "reports/raw/fast/small-cap-oracle-manipulation-routes.json"],
  ["bridge-nonlossless", "reports/raw/fast/bridge-nonlossless-collateral-join.json"],
  ["bridge-delta", "reports/raw/fast/bridge-delta-preflight.json"],
];

const LB_FACTORY = new ethers.Interface([
  "function getFlashLoanFee() view returns (uint256)",
  "function getFeeRecipient() view returns (address)",
  "function getLBPairImplementation() view returns (address)",
  "function getNumberOfLBPairs() view returns (uint256)",
  "function getLBPairAtIndex(uint256 id) view returns (address)",
  "function getNumberOfQuoteAssets() view returns (uint256)",
  "function getQuoteAssetAtIndex(uint256 index) view returns (address)",
  "function getAllBinSteps() view returns (uint256[])",
]);

const LB_PAIR = new ethers.Interface([
  "function implementation() view returns (address)",
  "function getFactory() view returns (address)",
  "function getTokenX() view returns (address)",
  "function getTokenY() view returns (address)",
  "function getBinStep() view returns (uint16)",
  "function getReserves() view returns (uint128 reserveX, uint128 reserveY)",
  "function getActiveId() view returns (uint24)",
  "function getLBHooksParameters() view returns (bytes32)",
  "function getOracleParameters() view returns (uint8 sampleLifetime, uint16 size, uint16 activeSize, uint40 lastUpdated, uint40 firstTimestamp)",
  "function getStaticFeeParameters() view returns (uint16 baseFactor,uint16 filterPeriod,uint16 decayPeriod,uint16 reductionFactor,uint24 variableFeeControl,uint16 protocolShare,uint24 maxVolatilityAccumulator)",
]);

const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const BYTES32_TOKEN = new ethers.Interface([
  "function name() view returns (bytes32)",
  "function symbol() view returns (bytes32)",
]);

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "MIM", "FRAX", "USDCE", "USDC.E", "USDE", "USDB", "USD1"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function isNonzeroBytes32(value) { const hex = strip0x(value); return Boolean(hex && !/^0+$/.test(hex)); }

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

function decodeBytes32String(value) { try { return safeText(ethers.decodeBytes32String(value), 40); } catch (_) { return null; } }
function stableFallback(symbol) { const s = String(symbol || "").toUpperCase(); return STABLE_SYMBOLS.has(s) ? 1 : null; }

function decimalsToNumber(value, decimals) {
  if (value === null || value === undefined || decimals === null || decimals === undefined) return null;
  try {
    const n = Number(ethers.formatUnits(BigInt(value), Number(decimals)));
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
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
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-joe-v22-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

function protocolMetadata() {
  for (const file of [PROTOCOLS, TEMP_PROTOCOLS]) {
    const raw = readJson(file, null);
    const arr = Array.isArray(raw) ? raw : raw?.value || raw?.protocols || [];
    const hit = arr.find((p) => p?.slug === "joe-v2.2" || p?.name === "Joe V2.2");
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
  return { name: "Joe V2.2", slug: "joe-v2.2", category: "Dexs", chains: ["Avalanche", "Arbitrum"], tvlUsd: null };
}

async function tokenMeta(rpc, chainId, address, prices) {
  const addr = normalizeAddress(address);
  if (!addr) return null;
  const [code, decimalsRaw, symbolRaw, symbolBytesRaw, nameRaw, nameBytesRaw, totalSupplyRaw] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, BYTES32_TOKEN, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, BYTES32_TOKEN, "name"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
  ]);
  const symbol = safeText(symbolRaw?.[0], 40) || decodeBytes32String(symbolBytesRaw?.[0]);
  const name = safeText(nameRaw?.[0], 80) || decodeBytes32String(nameBytesRaw?.[0]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const cfg = CHAINS[chainId];
  const key = `${cfg.coinSlug}:${addr.toLowerCase()}`;
  return {
    chainId,
    chain: cfg.name,
    address: addr,
    symbol,
    name,
    decimals,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    totalSupplyRaw: totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString(),
    priceUsd: prices[key] ?? stableFallback(symbol),
  };
}

async function loadPrices(keys) {
  const out = {};
  const uniqueKeys = unique(keys).map((k) => String(k).toLowerCase());
  for (let i = 0; i < uniqueKeys.length; i += 80) {
    const chunk = uniqueKeys.slice(i, i + 80);
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${chunk.join(",")}?searchWidth=6h`, 30_000);
    for (const [key, value] of Object.entries(json?.coins || {})) {
      const price = asNumber(value?.price);
      if (price !== null) out[key.toLowerCase()] = price;
    }
  }
  return out;
}

async function inspectFactory(chainId, rpc) {
  const cfg = CHAINS[chainId];
  const [factoryCode, routerCode, countRaw, implRaw, flashLoanFeeRaw, feeRecipientRaw, quoteCountRaw, binStepsRaw] = await Promise.all([
    getCode(rpc, cfg.factory),
    getCode(rpc, cfg.router),
    safeCall(rpc, cfg.factory, LB_FACTORY, "getNumberOfLBPairs"),
    safeCall(rpc, cfg.factory, LB_FACTORY, "getLBPairImplementation"),
    safeCall(rpc, cfg.factory, LB_FACTORY, "getFlashLoanFee"),
    safeCall(rpc, cfg.factory, LB_FACTORY, "getFeeRecipient"),
    safeCall(rpc, cfg.factory, LB_FACTORY, "getNumberOfQuoteAssets"),
    safeCall(rpc, cfg.factory, LB_FACTORY, "getAllBinSteps"),
  ]);
  const numberOfPairs = countRaw?.[0] === undefined ? null : Number(countRaw[0]);
  const quoteCount = quoteCountRaw?.[0] === undefined ? 0 : Math.min(Number(quoteCountRaw[0]), 25);
  const quoteAssets = [];
  for (let i = 0; i < quoteCount; i++) {
    const raw = await safeCall(rpc, cfg.factory, LB_FACTORY, "getQuoteAssetAtIndex", [i]);
    const addr = normalizeAddress(raw?.[0]);
    if (addr) quoteAssets.push(addr);
  }
  const cappedPairs = numberOfPairs === null ? 0 : Math.min(numberOfPairs, MAX_PAIRS_PER_CHAIN);
  const pairAddresses = await mapLimit(Array.from({ length: cappedPairs }, (_, i) => i), RPC_CONCURRENCY, async (i) => {
    const raw = await safeCall(rpc, cfg.factory, LB_FACTORY, "getLBPairAtIndex", [i]);
    return normalizeAddress(raw?.[0]);
  });

  return {
    chainId,
    chain: cfg.name,
    factory: cfg.factory,
    router: cfg.router,
    factoryCodePresent: Boolean(factoryCode && factoryCode !== "0x"),
    routerCodePresent: Boolean(routerCode && routerCode !== "0x"),
    pairImplementation: normalizeAddress(implRaw?.[0]),
    flashLoanFeeRaw: flashLoanFeeRaw?.[0] === undefined ? null : flashLoanFeeRaw[0].toString(),
    feeRecipient: normalizeAddress(feeRecipientRaw?.[0]),
    numberOfPairs,
    pairsEnumerated: pairAddresses.filter(Boolean).length,
    enumerationCapped: numberOfPairs !== null && numberOfPairs > MAX_PAIRS_PER_CHAIN,
    binSteps: Array.isArray(binStepsRaw?.[0]) ? binStepsRaw[0].map((x) => Number(x)) : [],
    quoteAssets,
    pairAddresses: pairAddresses.filter(Boolean),
  };
}

async function inspectPairs(chainId, rpc, pairAddresses) {
  const cfg = CHAINS[chainId];
  const firstPass = await mapLimit(pairAddresses, RPC_CONCURRENCY, async (pair, index) => {
    const [code, tokenXRaw, tokenYRaw, reservesRaw, activeIdRaw, binStepRaw, hooksRaw, oracleRaw, staticFeeRaw, implRaw, factoryRaw] = await Promise.all([
      getCode(rpc, pair),
      safeCall(rpc, pair, LB_PAIR, "getTokenX"),
      safeCall(rpc, pair, LB_PAIR, "getTokenY"),
      safeCall(rpc, pair, LB_PAIR, "getReserves"),
      safeCall(rpc, pair, LB_PAIR, "getActiveId"),
      safeCall(rpc, pair, LB_PAIR, "getBinStep"),
      safeCall(rpc, pair, LB_PAIR, "getLBHooksParameters"),
      safeCall(rpc, pair, LB_PAIR, "getOracleParameters"),
      safeCall(rpc, pair, LB_PAIR, "getStaticFeeParameters"),
      safeCall(rpc, pair, LB_PAIR, "implementation"),
      safeCall(rpc, pair, LB_PAIR, "getFactory"),
    ]);
    return {
      chainId,
      chain: cfg.name,
      index,
      pair,
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      tokenX: normalizeAddress(tokenXRaw?.[0]),
      tokenY: normalizeAddress(tokenYRaw?.[0]),
      reserveXRaw: reservesRaw?.[0] === undefined ? null : reservesRaw[0].toString(),
      reserveYRaw: reservesRaw?.[1] === undefined ? null : reservesRaw[1].toString(),
      activeId: activeIdRaw?.[0] === undefined ? null : Number(activeIdRaw[0]),
      binStep: binStepRaw?.[0] === undefined ? null : Number(binStepRaw[0]),
      hooksParameters: hooksRaw?.[0] || null,
      hooksEnabled: isNonzeroBytes32(hooksRaw?.[0]),
      oracle: oracleRaw ? {
        sampleLifetime: Number(oracleRaw[0]),
        size: Number(oracleRaw[1]),
        activeSize: Number(oracleRaw[2]),
        lastUpdated: Number(oracleRaw[3]),
        firstTimestamp: Number(oracleRaw[4]),
      } : null,
      staticFeeParameters: staticFeeRaw ? {
        baseFactor: Number(staticFeeRaw[0]),
        filterPeriod: Number(staticFeeRaw[1]),
        decayPeriod: Number(staticFeeRaw[2]),
        reductionFactor: Number(staticFeeRaw[3]),
        variableFeeControl: Number(staticFeeRaw[4]),
        protocolShare: Number(staticFeeRaw[5]),
        maxVolatilityAccumulator: Number(staticFeeRaw[6]),
      } : null,
      implementation: normalizeAddress(implRaw?.[0]),
      factory: normalizeAddress(factoryRaw?.[0]),
    };
  });

  const priceKeys = [];
  for (const row of firstPass) {
    for (const token of [row.tokenX, row.tokenY]) {
      const addr = lowerAddress(token);
      if (addr) priceKeys.push(`${cfg.coinSlug}:${addr}`);
    }
  }
  const prices = await loadPrices(priceKeys);

  const metaCache = new Map();
  async function meta(token) {
    const addr = lowerAddress(token);
    if (!addr) return null;
    const key = `${chainId}:${addr}`;
    if (!metaCache.has(key)) metaCache.set(key, tokenMeta(rpc, chainId, token, prices));
    return await metaCache.get(key);
  }

  const withMeta = await mapLimit(firstPass, RPC_CONCURRENCY, async (row) => {
    const [tokenXMeta, tokenYMeta] = await Promise.all([meta(row.tokenX), meta(row.tokenY)]);
    const reserveX = decimalsToNumber(row.reserveXRaw, tokenXMeta?.decimals);
    const reserveY = decimalsToNumber(row.reserveYRaw, tokenYMeta?.decimals);
    const reserveXUsd = reserveX !== null && tokenXMeta?.priceUsd !== null && tokenXMeta?.priceUsd !== undefined ? reserveX * tokenXMeta.priceUsd : null;
    const reserveYUsd = reserveY !== null && tokenYMeta?.priceUsd !== null && tokenYMeta?.priceUsd !== undefined ? reserveY * tokenYMeta.priceUsd : null;
    const poolTvlUsd = reserveXUsd === null && reserveYUsd === null ? null : (reserveXUsd || 0) + (reserveYUsd || 0);
    return {
      ...row,
      tokenXMeta,
      tokenYMeta,
      reserveX: round(reserveX, 8),
      reserveY: round(reserveY, 8),
      reserveXUsd: round(reserveXUsd, 2),
      reserveYUsd: round(reserveYUsd, 2),
      poolTvlUsd: round(poolTvlUsd, 2),
      symbolPair: `${tokenXMeta?.symbol || compactAddress(row.tokenX)}/${tokenYMeta?.symbol || compactAddress(row.tokenY)}`,
      material: (asNumber(poolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD,
      routePositive: false,
    };
  });

  return withMeta.sort((a, b) => (asNumber(b.poolTvlUsd) || 0) - (asNumber(a.poolTvlUsd) || 0));
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
  const fields = ["id", "protocol", "project", "name", "chain", "chainId", "surface", "side", "symbol", "asset", "token", "collateral", "borrowAsset", "loanAsset", "oracle", "source", "status", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "borrowAssetsUsd", "supplyAssetsUsd"];
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
  if (!obj || depth > 9 || out.length >= 300) return;
  if (Array.isArray(obj)) {
    for (const item of obj) scanObjectForAddresses(source, item, addressRoles, out, depth + 1);
    return;
  }
  if (typeof obj !== "object") return;
  const addrs = primitiveAddresses(obj);
  const hits = [...addrs].filter((addr) => addressRoles[addr]);
  if (hits.length) {
    out.push({
      source,
      hitRoles: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.role))),
      hitAddresses: hits.slice(0, 8),
      context: summarizeContext(obj),
      routePositive: false,
      blocker: "Local artifact address match is context only unless the LB pair itself is consumed by oracle/collateral logic with exact positive economics",
    });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(pairRows) {
  const roles = {};
  function add(addr, role, chain, pair, symbolPair) {
    const lower = lowerAddress(addr);
    if (!lower) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push({ role, chain, pair, symbolPair });
  }
  for (const row of pairRows) {
    add(row.pair, "lbPair", row.chain, row.pair, row.symbolPair);
    add(row.tokenX, "tokenX", row.chain, row.pair, row.symbolPair);
    add(row.tokenY, "tokenY", row.chain, row.pair, row.symbolPair);
  }
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) {
    const json = readJson(path.join(WORKSPACE, rel), null);
    if (!json) continue;
    scanObjectForAddresses(source, json, roles, matches);
  }
  const lbPairConsumerRows = matches.filter((row) => row.hitRoles.includes("lbPair"));
  const tokenContextRows = matches.filter((row) => !row.hitRoles.includes("lbPair"));
  return { matches, lbPairConsumerRows, tokenContextRows };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const topPairs = artifact.pairRows.slice(0, 10);
  const pairTable = topPairs.length ? topPairs.map((row) => `| ${row.chain} | ${compactAddress(row.pair)} | ${row.symbolPair} | ${row.binStep ?? "n/a"} | ${formatUsd(row.poolTvlUsd)} | ${row.oracle?.activeSize ?? 0}/${row.oracle?.size ?? 0} | ${row.hooksEnabled ? "yes" : "no"} |`).join("\n") : "| n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const factoryTable = artifact.factoryRows.map((row) => `| ${row.chain} | ${compactAddress(row.factory)} | ${row.factoryCodePresent ? "yes" : "no"} | ${row.numberOfPairs ?? "n/a"} | ${row.pairsEnumerated} | ${row.flashLoanFeeRaw ?? "n/a"} |`).join("\n");
  const consumerTable = artifact.directLbConsumerRows.length ? artifact.directLbConsumerRows.slice(0, 8).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${safeText(row.context?.protocol || row.context?.name || row.context?.surface || "context", 80)} |`).join("\n") : "| none | n/a | n/a | no LB pair address was found in local consumer artifacts |";

  return `# 🟢 DORMANT — Joe V2.2 Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. Joe V2.2/LFJ Liquidity Book pairs were mapped on Avalanche and Arbitrum, but no local lending/oracle consumer artifact references an LB pair address directly. Token-level matches are common-asset context only and do not prove that a Joe LB spot/TWAP or LP accounting path is trusted by a borrow, redemption, or liquidation consumer.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Supported chains scanned | ${s.chainsScanned} |
| Unsupported protocol chains | ${artifact.unsupportedProtocolChains.join(", ") || "none"} |
| Pairs enumerated | ${s.pairsEnumerated} |
| Material pairs | ${s.materialPairRows} |
| Oracle-enabled pairs | ${s.oracleEnabledRows} |
| Hook-enabled pairs | ${s.hookEnabledRows} |
| Direct LB consumer rows | ${s.directLbConsumerRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |

## Factories

| Chain | Factory | Code | Total pairs | Enumerated | Flash loan fee raw |
|---|---|---|---:|---:|---:|
${factoryTable}

## Top LB Pairs

| Chain | Pair | Tokens | Bin step | Pool TVL | Oracle active/size | Hooks |
|---|---|---|---:|---:|---:|---|
${pairTable}

## Direct Consumer Join

| Source | Hit roles | Addresses | Context |
|---|---|---|---|
${consumerTable}

## Blockers

- No LB pair address is currently found as lending collateral, a reserve asset, or an oracle bytecode reference in scanned local consumer artifacts.
- Token-level joins are dominated by common assets such as USDC/WETH/WAVAX and are not Joe-specific impact.
- Native LB flash loans and bin-price movement are not impact without a consumer that trusts that moved state.
- No exact acquisition, manipulation, borrow/redeem/liquidation, and exit economics are positive.

## Required For Route-Positive

- A deployed lending, vault, margin, or oracle consumer must reference a Joe V2.2 LB pair or its LB oracle state.
- The referenced pair state must be permissionlessly movable or stale in an attacker-favorable direction.
- Borrow, redemption, liquidation, or settlement liquidity must be material and exact-quoted.
- Fork extraction proof must show positive net value after gas, fees, slippage, and flash-loan repayment.

Artifacts: \`reports/raw/fast/joe-v22-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const chainIds = Object.keys(CHAINS).map(Number);
  const rpcs = await resolveRpcPool(chainIds);
  const factoryRows = [];
  const allPairs = [];

  for (const chainId of chainIds) {
    const rpc = rpcs[chainId];
    if (!rpc) {
      factoryRows.push({ chainId, chain: CHAINS[chainId].name, factory: CHAINS[chainId].factory, error: "noRpcForChain", pairAddresses: [] });
      continue;
    }
    const factory = await inspectFactory(chainId, rpc);
    factoryRows.push(factory);
    const pairRows = await inspectPairs(chainId, rpc, factory.pairAddresses);
    allPairs.push(...pairRows);
  }

  allPairs.sort((a, b) => (asNumber(b.poolTvlUsd) || 0) - (asNumber(a.poolTvlUsd) || 0));
  const joins = localConsumerJoins(allPairs);
  const directLbConsumerRows = joins.lbPairConsumerRows;
  const tokenContextRows = joins.tokenContextRows;
  const directLbPairAddresses = new Set(directLbConsumerRows.flatMap((row) => row.hitAddresses.map(lowerAddress)).filter(Boolean));
  const watchCandidates = allPairs
    .filter((row) => directLbPairAddresses.has(lowerAddress(row.pair)) && (asNumber(row.poolTvlUsd) || 0) >= MIN_WATCH_POOL_TVL_USD)
    .map((row) => ({ ...row, reason: "LB pair address appears in a consumer artifact and has material pool TVL", routePositive: false }));

  const summary = {
    chainsScanned: chainIds.filter((id) => rpcs[id]).length,
    chainsWithRpc: chainIds.filter((id) => rpcs[id]),
    chainsMissingRpc: chainIds.filter((id) => !rpcs[id]),
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS.length,
    factoriesScanned: factoryRows.filter((row) => !row.error).length,
    pairsAvailable: factoryRows.reduce((sum, row) => sum + (asNumber(row.numberOfPairs) || 0), 0),
    pairsEnumerated: allPairs.length,
    materialPairRows: allPairs.filter((row) => (asNumber(row.poolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD).length,
    oracleEnabledRows: allPairs.filter((row) => (asNumber(row.oracle?.activeSize) || 0) > 0).length,
    hookEnabledRows: allPairs.filter((row) => row.hooksEnabled).length,
    directLbConsumerRows: directLbConsumerRows.length,
    tokenContextRows: tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    maxPoolTvlUsd: round(Math.max(0, ...allPairs.map((row) => asNumber(row.poolTvlUsd) || 0)), 2),
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closedReason: directLbConsumerRows.length
      ? "LB pair consumer references found, but no exact-positive manipulation/borrow/exit economics or fork proof"
      : "no Joe V2.2 LB pair address is referenced by scanned lending/oracle consumer artifacts",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-joe-v22-phase0.js",
    scope: "Read-only Joe V2.2 Liquidity Book pair and consumer-route Phase 0 scan",
    target: {
      name: "Joe V2.2",
      slug: "joe-v2.2",
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
      maxPairsPerChain: MAX_PAIRS_PER_CHAIN,
      minMaterialPoolTvlUsd: MIN_MATERIAL_POOL_TVL_USD,
      minWatchPoolTvlUsd: MIN_WATCH_POOL_TVL_USD,
    },
    docs: {
      contracts: "https://docs.lfj.gg/lfj-dex/contracts.md",
      audits: metadata.auditLinks || [],
      sourceRepo: "https://github.com/traderjoe-xyz/joe-v2",
    },
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS,
    factoryRows: factoryRows.map((row) => ({ ...row, pairAddresses: undefined })),
    pairRows: allPairs,
    directLbConsumerRows,
    tokenContextRows: tokenContextRows.slice(0, 100),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: [
      "No LB pair address is referenced by scanned lending/oracle consumer artifacts",
      "Token-level matches are common-asset context and not Joe-specific impact",
      "Native LB flash loans and bin movement need an external trusted consumer before they matter",
      "No exact positive acquisition/manipulation/borrow/exit economics or fork proof",
    ],
    requiredForRoutePositive: [
      "deployed consumer references a Joe V2.2 LB pair or LB oracle state",
      "pair/oracle state is permissionlessly movable or stale in attacker-favorable direction",
      "borrow, redemption, liquidation, or settlement route is exact-quoted and positive",
      "fork extraction proof",
    ],
    nextReadOnlyStep: directLbConsumerRows.length
      ? "Static-review the matched consumer and exact-quote only if LB state affects accepted value."
      : "Reopen Joe V2.2 only if a lending/oracle consumer references an LB pair or a new adapter consumes LB oracle state.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));

  if (!QUIET) {
    console.log(`Joe V2.2 Phase 0: pairs=${summary.pairsEnumerated} material=${summary.materialPairRows} directLbConsumers=${summary.directLbConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
