#!/usr/bin/env node
// scan-pancakeswap-infinity-phase0.js - bounded read-only Phase 0 for PancakeSwap Infinity pool-manager/vault consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool, loadRpcUrls, PUBLIC_FALLBACKS } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "pancakeswap-infinity-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "pancakeswap-infinity-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const MIN_MATERIAL_BALANCE_USD = Number(process.env.PANCAKE_INFINITY_MIN_MATERIAL_BALANCE_USD || "100000");
const LOG_LOOKBACK_BLOCKS = Number(process.env.PANCAKE_INFINITY_LOG_LOOKBACK_BLOCKS || "1000000");
const LOG_CHUNK_BLOCKS = Number(process.env.PANCAKE_INFINITY_LOG_CHUNK_BLOCKS || "100000");
const MIN_LOG_CHUNK_BLOCKS = Number(process.env.PANCAKE_INFINITY_MIN_LOG_CHUNK_BLOCKS || "10000");
const MAX_TOKEN_ROWS = Number(process.env.PANCAKE_INFINITY_MAX_TOKEN_ROWS || "2500");
const TOKEN_CONCURRENCY = Number(process.env.PANCAKE_INFINITY_TOKEN_CONCURRENCY || "16");
const HISTORICAL_PROBE_BLOCKS = Number(process.env.PANCAKE_INFINITY_HISTORICAL_PROBE_BLOCKS || "50000");
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";

const VAULT = "0x238a358808379702088667322f80ac48bad5e6c4";
const CL_POOL_MANAGER = "0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b";
const CHAINS = {
  56: { name: "BNB Chain", llamaNames: ["Binance", "BSC", "BNB"], coinSlug: "bsc", nativeKey: "coingecko:binancecoin", vault: VAULT, poolManager: CL_POOL_MANAGER, fromBlock: 47214308 },
  8453: { name: "Base", llamaNames: ["Base"], coinSlug: "base", nativeKey: "coingecko:ethereum", vault: VAULT, poolManager: CL_POOL_MANAGER, fromBlock: 30544106 },
};
const CHAIN_IDS = Object.keys(CHAINS).map(Number);
const BLACKLIST_TOKENS = new Set([
  "0x5e0a1d876557cf43c66c08c8a247bc4954eca8bd",
  "0xb4357054c3da8d46ed642383f03139ac7f090343",
  "0x8d010bf9c26881788b4e6bf5fd1bdc358c8f90b8",
]);
const CORE_TOKENS = {
  56: {
    WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    USDT: "0x55d398326f99059fF775485246999027B3197955",
    USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    BTCB: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
    ETH: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    FDUSD: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409",
    CAKE: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
  },
  8453: {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  },
};

const INFINITY = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, address hooks, uint24 fee, bytes32 parameters, uint160 sqrtPriceX96, int24 tick)",
]);
const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);

const CONSUMER_ARTIFACTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["seven-chain-lending", "reports/raw/fast/seven-chain-lending-coverage.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["evault-collateral-nav", "reports/raw/fast/evault-collateral-nav-manipulation.json"],
  ["focused-morpho", "reports/raw/fast/focused-morpho-review-producers.json"],
  ["focused-euler", "reports/raw/fast/focused-euler-evk-review-producers.json"],
  ["morpho-public-allocator", "reports/raw/fast/morpho-public-allocator-force-feed.json"],
  ["pool-share-snapshot", "reports/raw/fast/pool-share-snapshot-drift.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
  ["small-cap-oracle", "reports/raw/fast/small-cap-oracle-manipulation-routes.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-synthetic-consumer", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
];
const DIRECT_SOURCE_SET = new Set([
  "aave-euler-silo",
  "consumer-first-high-ltv",
  "seven-chain-lending",
  "stablecoin-depeg",
  "erc4626-consumer",
  "evault-collateral-nav",
  "focused-morpho",
  "focused-euler",
  "morpho-public-allocator",
  "pool-share-snapshot",
  "public-lead-consumer",
  "small-cap-oracle",
  "bridge-proof-binding",
  "bridge-synthetic-consumer",
]);
const DIRECT_ROLES = new Set(["vault", "poolManager", "hook"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function safeText(value, max = 140) { return String(value || "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function decodeBytes32String(value) { try { return safeText(ethers.decodeBytes32String(value), 40); } catch (_) { return null; } }
function asNumber(value) { const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 4) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function decimalsToNumber(value, decimals) { try { if (value === null || value === undefined || decimals === null || decimals === undefined) return null; const n = Number(ethers.formatUnits(BigInt(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function toHexBlock(n) { return `0x${Math.max(0, Number(n) || 0).toString(16)}`; }
function isZeroAddress(value) { return lowerAddress(value) === ZERO; }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
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
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-pancake-infinity-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) { return null; }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

async function ethBalance(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return null;
  try { return (await rpcCall(rpc, "eth_getBalance", [addr, "latest"], 10_000)).toString(); } catch (_) { return null; }
}

function discoveryRows() {
  const d = readJson(PUBLIC_TARGETS, {});
  return [...(d.phase0Queue || []), ...(d.consumerJoinFirst || []), ...(d.protocolCandidates || []), ...(d.targetedRefreshQueue || []), ...(d.yieldCandidates || []), ...(d.targets || []), ...(d.value || [])];
}

function protocolMetadata() {
  const row = discoveryRows().find((p) => p?.slug === "pancakeswap-infinity" || p?.name === "PancakeSwap Infinity");
  if (row) return { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], evmChains: row.evmChains || [], tvlUsd: round(row.tvlUsd, 2), change1dPct: row.change1dPct ?? null, change7dPct: row.change7dPct ?? null, routePriority: row.routePriority || null, source: "public-audit-target-discovery" };
  return { name: "PancakeSwap Infinity", slug: "pancakeswap-infinity", category: "Dexs", chains: ["Binance", "Base"], evmChains: ["Binance", "Base"], tvlUsd: null };
}

async function latestBlock(rpc) {
  const hex = await rpcCall(rpc, "eth_blockNumber", [], 10_000).catch(() => null);
  return hex ? parseInt(hex, 16) : null;
}

async function supportsHistoricalInitializeLogs(rpc, chainId, chain) {
  if (!rpc || !chain) return false;
  const id = await rpcCall(rpc, "eth_chainId", [], 4_000).catch(() => null);
  if (!id || parseInt(id, 16) !== Number(chainId)) return false;
  const topic = INFINITY.getEvent("Initialize").topicHash;
  const from = Number(chain.fromBlock);
  const to = from + HISTORICAL_PROBE_BLOCKS - 1;
  const logs = await rpcCall(rpc, "eth_getLogs", [{ address: normalizeAddress(chain.poolManager), fromBlock: toHexBlock(from), toBlock: toHexBlock(to), topics: [topic] }], 15_000).catch(() => null);
  return Array.isArray(logs);
}

async function resolveHistoricalLogRpc(chainId, fallbackRpc, chain) {
  const sanitized = { historicalSupported: false, selected: "default", chainId, candidatesTested: 0, supportingCandidatesSeen: 0 };
  if (await supportsHistoricalInitializeLogs(fallbackRpc, chainId, chain)) {
    sanitized.historicalSupported = true;
    sanitized.candidatesTested = 1;
    return { rpc: fallbackRpc, sanitized };
  }
  const urls = [...loadRpcUrls(), PUBLIC_FALLBACKS[chainId]].filter(Boolean);
  const seen = new Set();
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sanitized.candidatesTested += 1;
    const ok = await supportsHistoricalInitializeLogs(url, chainId, chain);
    if (!ok) continue;
    sanitized.historicalSupported = true;
    sanitized.supportingCandidatesSeen += 1;
    sanitized.selected = fallbackRpc && url === fallbackRpc ? "default" : "historical-capable-inventory-candidate";
    return { rpc: url, sanitized };
  }
  return { rpc: fallbackRpc, sanitized };
}

async function getLogsChunked(rpc, filter, fromBlock, toBlock) {
  const out = [];
  const errors = [];
  let chunks = 0;
  let chunkBlocks = LOG_CHUNK_BLOCKS;
  let start = Number(fromBlock);
  const last = Number(toBlock);
  while (start <= last) {
    const end = Math.min(last, start + chunkBlocks - 1);
    const part = await rpcCall(rpc, "eth_getLogs", [{ ...filter, fromBlock: toHexBlock(start), toBlock: toHexBlock(end) }], 12_000);
    if (Array.isArray(part)) {
      out.push(...part);
      chunks += 1;
      start = end + 1;
      if (chunkBlocks < LOG_CHUNK_BLOCKS && part.length < 2000) chunkBlocks = Math.min(LOG_CHUNK_BLOCKS, chunkBlocks * 2);
      continue;
    }
    if (chunkBlocks > MIN_LOG_CHUNK_BLOCKS) {
      chunkBlocks = Math.max(MIN_LOG_CHUNK_BLOCKS, Math.floor(chunkBlocks / 2));
      continue;
    }
    errors.push({ fromBlock: start, toBlock: end, reason: "eth_getLogs-null-result" });
    chunks += 1;
    start = end + 1;
  }
  return { logs: out, chunks, errors };
}

function parseInitializeLog(log, chainId, chain) {
  try {
    const parsed = INFINITY.parseLog(log);
    const currency0 = normalizeAddress(parsed.args.currency0);
    const currency1 = normalizeAddress(parsed.args.currency1);
    const hook = normalizeAddress(parsed.args.hooks);
    return {
      chainId,
      chain: chain.name,
      poolId: String(parsed.args.id).toLowerCase(),
      currency0,
      currency1,
      hook,
      fee: Number(parsed.args.fee),
      parameters: String(parsed.args.parameters),
      sqrtPriceX96: parsed.args.sqrtPriceX96.toString(),
      tick: Number(parsed.args.tick),
      blockNumber: parseInt(log.blockNumber, 16),
      transactionHash: log.transactionHash || null,
      routePositive: false,
    };
  } catch (_) { return null; }
}

async function scanChainPools(rpc, chainId, chain, selection = {}) {
  if (!rpc) return { contractRow: { chainId, chain: chain.name, rpcAvailable: false, adapterFromBlock: chain.fromBlock, latestBlock: null }, poolRows: [], logStats: { logs: 0, chunks: 0, errors: 0 } };
  const latest = await latestBlock(rpc);
  const [vaultCode, managerCode] = await Promise.all([getCode(rpc, chain.vault), getCode(rpc, chain.poolManager)]);
  const contractRow = {
    chainId,
    chain: chain.name,
    rpcAvailable: true,
    adapterFromBlock: chain.fromBlock,
    latestBlock: latest,
    vault: normalizeAddress(chain.vault),
    vaultCodePresent: Boolean(vaultCode && vaultCode !== "0x"),
    vaultCodeBytes: vaultCode && vaultCode !== "0x" ? strip0x(vaultCode).length / 2 : 0,
    poolManager: normalizeAddress(chain.poolManager),
    poolManagerCodePresent: Boolean(managerCode && managerCode !== "0x"),
    poolManagerCodeBytes: managerCode && managerCode !== "0x" ? strip0x(managerCode).length / 2 : 0,
    historicalLogSupported: Boolean(selection.historicalSupported),
    rpcSelection: selection.selected || "default",
  };
  if (!latest) return { contractRow, poolRows: [], logStats: { logs: 0, chunks: 0, errors: 1 } };
  const topic = INFINITY.getEvent("Initialize").topicHash;
  const scanFromBlock = selection.historicalSupported ? chain.fromBlock : Math.max(chain.fromBlock, latest - LOG_LOOKBACK_BLOCKS);
  contractRow.logFromBlock = scanFromBlock;
  contractRow.logLookbackBlocks = latest - scanFromBlock;
  contractRow.logScanMode = selection.historicalSupported ? "adapter-from-block" : "bounded-recent-lookback";
  const { logs, chunks, errors } = await getLogsChunked(rpc, { address: normalizeAddress(chain.poolManager), topics: [topic] }, scanFromBlock, latest);
  const deduped = new Map();
  for (const log of logs) {
    const row = parseInitializeLog(log, chainId, chain);
    if (!row) continue;
    const key = `${chainId}:${row.poolId}`;
    const prev = deduped.get(key);
    if (!prev || row.blockNumber < prev.blockNumber) deduped.set(key, row);
  }
  return { contractRow, poolRows: [...deduped.values()].sort((a, b) => b.blockNumber - a.blockNumber), logStats: { logs: logs.length, uniquePools: deduped.size, chunks, errors: errors.length, errorSamples: errors.slice(0, 6) } };
}

async function loadPrices(tokenRefs) {
  const keys = unique(tokenRefs.map((t) => t.priceKey).filter(Boolean));
  const out = {};
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${chunk.join(",")}?searchWidth=6h`, 30_000);
    for (const [key, value] of Object.entries(json?.coins || {})) {
      const price = asNumber(value?.price);
      if (price !== null) out[key.toLowerCase()] = price;
    }
  }
  return out;
}

function tokenRefsFromPools(poolRows) {
  const refs = new Map();
  function addRef(chainId, chainName, address, poolId = null) {
    const chain = CHAINS[chainId];
    const addr = normalizeAddress(address);
    if (!chain || !addr) return;
    const lower = addr.toLowerCase();
    if (BLACKLIST_TOKENS.has(lower)) return;
    const key = `${chainId}:${lower}`;
    const prev = refs.get(key) || { chainId, chain: chainName || chain.name, address: addr, native: lower === ZERO, pools: 0, poolIds: [], priceKey: lower === ZERO ? chain.nativeKey : `${chain.coinSlug}:${lower}`, coreFallback: false };
    if (poolId) {
      prev.pools += 1;
      if (prev.poolIds.length < 10) prev.poolIds.push(poolId);
    }
    refs.set(key, prev);
  }
  for (const row of poolRows) {
    for (const currency of [row.currency0, row.currency1]) addRef(row.chainId, row.chain, currency, row.poolId);
  }
  for (const [chainIdRaw, tokens] of Object.entries(CORE_TOKENS)) {
    const chainId = Number(chainIdRaw);
    for (const token of Object.values(tokens)) {
      addRef(chainId, CHAINS[chainId]?.name, token, null);
      const ref = refs.get(`${chainId}:${normalizeAddress(token).toLowerCase()}`);
      if (ref) ref.coreFallback = true;
    }
  }
  return [...refs.values()].slice(0, MAX_TOKEN_ROWS);
}

async function tokenMetaAndBalance(rpc, chain, ref, prices) {
  const native = ref.native || isZeroAddress(ref.address);
  const priceUsd = prices[String(ref.priceKey || "").toLowerCase()] ?? null;
  if (native) {
    const raw = await ethBalance(rpc, chain.vault);
    const amount = decimalsToNumber(raw, 18);
    return { ...ref, symbol: chain.chainId === 56 ? "BNB" : "ETH", name: chain.chainId === 56 ? "BNB" : "Ether", decimals: 18, codePresent: false, codeBytes: 0, balanceRaw: raw, balance: round(amount, 8), priceUsd: round(priceUsd, 8), balanceUsd: amount !== null && priceUsd !== null ? round(amount * priceUsd, 2) : null, material: (amount !== null && priceUsd !== null ? amount * priceUsd : 0) >= MIN_MATERIAL_BALANCE_USD, routePositive: false };
  }
  const [code, decimalsRaw, symbolRaw, symbolBytesRaw, nameRaw, nameBytesRaw, totalSupplyRaw, balanceRaw] = await Promise.all([
    getCode(rpc, ref.address),
    safeCall(rpc, ref.address, ERC20, "decimals"),
    safeCall(rpc, ref.address, ERC20, "symbol"),
    safeCall(rpc, ref.address, BYTES32_TOKEN, "symbol"),
    safeCall(rpc, ref.address, ERC20, "name"),
    safeCall(rpc, ref.address, BYTES32_TOKEN, "name"),
    safeCall(rpc, ref.address, ERC20, "totalSupply"),
    safeCall(rpc, ref.address, ERC20, "balanceOf", [normalizeAddress(chain.vault)]),
  ]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const balance = decimalsToNumber(balanceRaw?.[0]?.toString(), decimals);
  const totalSupply = decimalsToNumber(totalSupplyRaw?.[0]?.toString(), decimals);
  const balanceUsd = balance !== null && priceUsd !== null ? balance * priceUsd : null;
  return {
    ...ref,
    symbol: safeText(symbolRaw?.[0], 40) || decodeBytes32String(symbolBytesRaw?.[0]),
    name: safeText(nameRaw?.[0], 80) || decodeBytes32String(nameBytesRaw?.[0]),
    decimals,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    totalSupplyRaw: totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString(),
    totalSupply: round(totalSupply, 6),
    balanceRaw: balanceRaw?.[0] === undefined ? null : balanceRaw[0].toString(),
    balance: round(balance, 8),
    priceUsd: round(priceUsd, 8),
    balanceUsd: round(balanceUsd, 2),
    material: (asNumber(balanceUsd) || 0) >= MIN_MATERIAL_BALANCE_USD,
    routePositive: false,
  };
}

async function inspectTokens(rpcs, poolRows) {
  const refs = tokenRefsFromPools(poolRows);
  const prices = await loadPrices(refs);
  const rows = await mapLimit(refs, TOKEN_CONCURRENCY, async (ref) => {
    const chain = CHAINS[ref.chainId];
    const rpc = rpcs[ref.chainId];
    if (!chain || !rpc) return null;
    return await tokenMetaAndBalance(rpc, { ...chain, chainId: ref.chainId }, ref, prices);
  });
  return rows.filter(Boolean).sort((a, b) => (asNumber(b.balanceUsd) || 0) - (asNumber(a.balanceUsd) || 0));
}

async function inspectHooks(rpcs, poolRows) {
  const hookMap = new Map();
  for (const row of poolRows) {
    const hook = normalizeAddress(row.hook);
    if (!hook || hook.toLowerCase() === ZERO) continue;
    const key = `${row.chainId}:${hook.toLowerCase()}`;
    const prev = hookMap.get(key) || { chainId: row.chainId, chain: row.chain, hook, pools: 0, poolIds: [], routePositive: false };
    prev.pools += 1;
    if (prev.poolIds.length < 12) prev.poolIds.push(row.poolId);
    hookMap.set(key, prev);
  }
  const rows = await mapLimit([...hookMap.values()], 8, async (row) => {
    const code = await getCode(rpcs[row.chainId], row.hook);
    return { ...row, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0 };
  });
  return rows.sort((a, b) => b.pools - a.pools);
}

function enrichPoolRows(poolRows, tokenRows, hookRows) {
  const tokenByKey = new Map(tokenRows.map((row) => [`${row.chainId}:${row.address.toLowerCase()}`, row]));
  const hookByKey = new Map(hookRows.map((row) => [`${row.chainId}:${row.hook.toLowerCase()}`, row]));
  return poolRows.map((row) => {
    const t0 = tokenByKey.get(`${row.chainId}:${row.currency0.toLowerCase()}`);
    const t1 = tokenByKey.get(`${row.chainId}:${row.currency1.toLowerCase()}`);
    const hook = row.hook ? hookByKey.get(`${row.chainId}:${row.hook.toLowerCase()}`) : null;
    const maxCurrencyBalanceUsd = Math.max(asNumber(t0?.balanceUsd) || 0, asNumber(t1?.balanceUsd) || 0);
    return { ...row, currency0Symbol: t0?.symbol || (isZeroAddress(row.currency0) ? (row.chainId === 56 ? "BNB" : "ETH") : null), currency1Symbol: t1?.symbol || (isZeroAddress(row.currency1) ? (row.chainId === 56 ? "BNB" : "ETH") : null), hookCodePresent: Boolean(hook?.codePresent), hookPoolCount: hook?.pools || (isZeroAddress(row.hook) ? 0 : 1), maxCurrencyBalanceUsd: round(maxCurrencyBalanceUsd, 2), materialContext: maxCurrencyBalanceUsd >= MIN_MATERIAL_BALANCE_USD, routePositive: false };
  });
}

function primitiveAddresses(value, out = new Set()) {
  if (typeof value === "string") { for (const m of value.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0].toLowerCase()); }
  else if (Array.isArray(value)) { for (const item of value) primitiveAddresses(item, out); }
  else if (value && typeof value === "object") { for (const item of Object.values(value)) primitiveAddresses(item, out); }
  return out;
}

function summarizeContext(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "project", "name", "chain", "chainId", "surface", "side", "symbol", "asset", "token", "collateral", "borrowAsset", "loanAsset", "oracle", "source", "status", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "borrowAssetsUsd", "supplyAssetsUsd", "file", "rootFile"];
  const out = {};
  for (const field of fields) { const value = obj[field]; if (value === undefined) continue; out[field] = typeof value === "object" ? safeText(JSON.stringify(value), 180) : safeText(value, 180); }
  return out;
}

function scanObjectForAddresses(source, obj, addressRoles, out, depth = 0) {
  if (!obj || depth > 9 || out.length >= 900) return;
  if (Array.isArray(obj)) { for (const item of obj) scanObjectForAddresses(source, item, addressRoles, out, depth + 1); return; }
  if (typeof obj !== "object") return;
  const hits = [...primitiveAddresses(obj)].filter((addr) => addressRoles[addr]);
  if (hits.length) {
    const roles = unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.role)));
    out.push({
      source,
      hitRoles: roles,
      hitAddresses: hits.slice(0, 12),
      chains: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.chain)).filter(Boolean)).slice(0, 8),
      symbols: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.symbol)).filter(Boolean)).slice(0, 12),
      directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)),
      context: summarizeContext(obj),
      routePositive: false,
      blocker: "Local artifact address match is context only unless Infinity manager/vault/hook state is trusted by consumer logic with exact positive economics",
    });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(contractRows, tokenRows, hookRows) {
  const roles = {};
  function add(addr, role) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push(role);
  }
  for (const row of contractRows) {
    add(row.vault, { role: "vault", chain: row.chain, symbol: "InfinityVault" });
    add(row.poolManager, { role: "poolManager", chain: row.chain, symbol: "InfinityCLPoolManager" });
  }
  for (const row of hookRows) add(row.hook, { role: "hook", chain: row.chain, symbol: "InfinityHook" });
  for (const row of tokenRows) add(row.address, { role: "token", chain: row.chain, symbol: row.symbol || "token" });
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) { const json = readJson(path.join(WORKSPACE, rel), null); if (json) scanObjectForAddresses(source, json, roles, matches); }
  return { directConsumerRows: matches.filter((row) => row.directConsumer), tokenContextRows: matches.filter((row) => !row.directConsumer) };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const contractTable = artifact.contractRows.map((row) => `| ${row.chain} | ${compactAddress(row.vault)} | ${row.vaultCodePresent ? "yes" : "no"} | ${compactAddress(row.poolManager)} | ${row.poolManagerCodePresent ? "yes" : "no"} | ${row.historicalLogSupported ? "yes" : "no"} | ${row.logScanMode || "n/a"} | ${row.logFromBlock ?? "n/a"} | ${row.poolRows ?? 0} |`).join("\n");
  const tokenTable = artifact.tokenRows.slice(0, 15).map((row) => `| ${row.chain} | ${row.symbol || compactAddress(row.address)} | ${compactAddress(row.address)} | ${row.codePresent || row.native ? "yes" : "no"} | ${formatNumber(row.balance, 4)} | ${formatUsd(row.balanceUsd)} | ${row.pools} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const hookTable = artifact.hookRows.length ? artifact.hookRows.slice(0, 12).map((row) => `| ${row.chain} | ${compactAddress(row.hook)} | ${row.codePresent ? "yes" : "no"} | ${row.codeBytes} | ${row.pools} |`).join("\n") : "| none | n/a | n/a | n/a | no non-zero hooks found |";
  const poolTable = artifact.poolRows.slice(0, 12).map((row) => `| ${row.chain} | ${safeText(row.poolId, 14)} | ${row.currency0Symbol || compactAddress(row.currency0)} | ${row.currency1Symbol || compactAddress(row.currency1)} | ${row.fee} | ${compactAddress(row.hook)} | ${row.materialContext ? "yes" : "no"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const consumerTable = artifact.directConsumerRows.length ? artifact.directConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.chains.join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Infinity vault/manager/hook address was found in consumer-grade artifacts |";
  return `# ${SIGNAL_DORMANT} - PancakeSwap Infinity Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. PancakeSwap Infinity is a hook-based AMM whose DeFiLlama adapter reads PoolManager \`Initialize\` logs and sums token balances in a shared Vault, not a V2 pair or V3 pool-contract factory. The pass mapped BSC/Base vault and CL pool-manager bytecode, adapter-from-block initialized pool IDs where historical logs are supported, hook contracts, current vault token balances for observed currencies, and local consumer joins. Token-level joins are common-asset context only; route-positive requires a deployed consumer that trusts Infinity vault, manager, hook, pool-accounting, or oracle state plus exact positive borrow, redemption, liquidation, settlement, or unwind economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Chains with RPC | ${s.chainsWithRpc} |
| Historical-log supported chains | ${s.historicalLogSupportedChains} |
| Fallback log lookback blocks | ${s.logLookbackBlocks} |
| Initialize logs | ${s.initializeLogs} |
| Pools mapped | ${s.poolRows} |
| Hooks mapped | ${s.hookRows} |
| Hook contracts with code | ${s.hookRowsWithCode} |
| Vault token rows | ${s.tokenRows} |
| Material vault token rows | ${s.materialTokenRows} |
| Vault balance context | ${formatUsd(s.totalVaultBalanceUsd)} |
| Direct consumer rows | ${s.directConsumerRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |

## Contracts

| Chain | Vault | Vault code | Pool manager | Manager code | Historical logs | Log scan mode | From block | Pools |
|---|---|---|---|---|---|---|---:|---:|
${contractTable}

## Top Vault Balances

| Chain | Token | Address | Code | Balance | USD | Pool refs |
|---|---|---|---|---:|---:|---:|
${tokenTable}

## Hooks

| Chain | Hook | Code | Code bytes | Pools |
|---|---|---|---:|---:|
${hookTable}

## Recent Pool IDs

| Chain | Pool id | Currency0 | Currency1 | Fee | Hook | Material token context |
|---|---|---|---|---:|---|---|
${poolTable}

## Direct Infinity Consumer Join

| Source | Hit roles | Addresses | Chains | Context |
|---|---|---|---|---|
${consumerTable}

## Blockers

- Infinity pools are \`bytes32\` IDs in a shared manager/vault architecture, not standalone LP/pool contracts that can be joined as ERC20 collateral.
- No Infinity vault, pool manager, or hook address is currently found as trusted lending collateral, reserve asset, oracle source, bridge verifier, or settlement target in scanned consumer-grade artifacts.
- Token-level joins are common-asset context and do not prove Infinity-specific accepted-value impact.
- Vault token balances do not prove per-pool manipulability or accepted-value divergence without a consumer that reads Infinity state.
- No exact positive borrow, redemption, liquidation, settlement, or DEX unwind economics and no fork extraction proof exist.

## Required For Route-Positive

- A deployed lending, vault, margin, oracle, bridge, or settlement consumer references Infinity vault, manager, hook, pool ID, or accounting state.
- The referenced state is permissionlessly movable, stale, hook-manipulable, or otherwise attacker-favorable.
- Borrow, redemption, liquidation, bridge, settlement, or unwind route is exact-quoted and positive after fees, gas, and slippage.
- Fork/local proof shows positive net value.

Artifacts: \`reports/raw/fast/pancakeswap-infinity-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const baseRpcs = await resolveRpcPool(CHAIN_IDS);
  const rpcs = { ...baseRpcs };
  const rpcSelection = {};
  for (const chainId of CHAIN_IDS) {
    const selected = await resolveHistoricalLogRpc(chainId, baseRpcs[chainId], CHAINS[chainId]);
    rpcs[chainId] = selected.rpc;
    rpcSelection[chainId] = selected.sanitized;
  }
  const chainScans = await Promise.all(CHAIN_IDS.map((chainId) => scanChainPools(rpcs[chainId], chainId, CHAINS[chainId], rpcSelection[chainId])));
  const contractRows = chainScans.map((scan) => ({ ...scan.contractRow, poolRows: scan.poolRows.length, initializeLogs: scan.logStats.logs, logChunks: scan.logStats.chunks, logErrors: scan.logStats.errors }));
  const rawPoolRows = chainScans.flatMap((scan) => scan.poolRows);
  const tokenRows = await inspectTokens(rpcs, rawPoolRows);
  const hookRows = await inspectHooks(rpcs, rawPoolRows);
  const poolRows = enrichPoolRows(rawPoolRows, tokenRows, hookRows);
  const joins = localConsumerJoins(contractRows, tokenRows, hookRows);
  const watchCandidates = joins.directConsumerRows.map((row) => ({ ...row, reason: "Infinity vault/manager/hook appears in a consumer-grade artifact; needs static review and exact economics", routePositive: false }));
  const summary = {
    rpcAvailability: Object.fromEntries(CHAIN_IDS.map((chainId) => [chainId, Boolean(rpcs[chainId])])),
    historicalLogSupportedChains: contractRows.filter((row) => row.historicalLogSupported).length,
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    chainsWithRpc: contractRows.filter((row) => row.rpcAvailable).length,
    logLookbackBlocks: LOG_LOOKBACK_BLOCKS,
    initializeLogs: contractRows.reduce((sum, row) => sum + (asNumber(row.initializeLogs) || 0), 0),
    logChunks: contractRows.reduce((sum, row) => sum + (asNumber(row.logChunks) || 0), 0),
    logErrors: contractRows.reduce((sum, row) => sum + (asNumber(row.logErrors) || 0), 0),
    poolRows: poolRows.length,
    materialPoolContextRows: poolRows.filter((row) => row.materialContext).length,
    hookRows: hookRows.length,
    hookRowsWithCode: hookRows.filter((row) => row.codePresent).length,
    tokenRows: tokenRows.length,
    tokenRowsWithCode: tokenRows.filter((row) => row.codePresent || row.native).length,
    materialTokenRows: tokenRows.filter((row) => row.material).length,
    totalVaultBalanceUsd: round(tokenRows.reduce((sum, row) => sum + (asNumber(row.balanceUsd) || 0), 0), 2),
    maxVaultTokenBalanceUsd: round(Math.max(0, ...tokenRows.map((row) => asNumber(row.balanceUsd) || 0)), 2),
    directConsumerRows: joins.directConsumerRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closedReason: joins.directConsumerRows.length ? "Infinity-specific address references found, but no exact-positive consumer economics or proof" : "no Infinity vault, pool manager, or hook address is referenced by scanned consumer-grade artifacts",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-pancakeswap-infinity-phase0.js",
    scope: "Read-only PancakeSwap Infinity PoolManager/Vault/hook and consumer-route Phase 0 scan",
    target: { name: "PancakeSwap Infinity", slug: "pancakeswap-infinity", category: "Dexs", surface: "dex-oracle-consumer-only", metadata },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    thresholds: { minMaterialBalanceUsd: MIN_MATERIAL_BALANCE_USD, historicalProbeBlocks: HISTORICAL_PROBE_BLOCKS, logLookbackBlocks: LOG_LOOKBACK_BLOCKS, logChunkBlocks: LOG_CHUNK_BLOCKS, minLogChunkBlocks: MIN_LOG_CHUNK_BLOCKS, maxTokenRows: MAX_TOKEN_ROWS, tokenConcurrency: TOKEN_CONCURRENCY },
    docs: { adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/pancakeswap-infinity/index.js", addressDocs: "https://developer.pancakeswap.finance/contracts/infinity/resources/addresses" },
    rpcSelection,
    contractRows,
    logStatsByChain: Object.fromEntries(chainScans.map((scan) => [scan.contractRow.chainId, scan.logStats])),
    poolRows,
    tokenRows,
    hookRows,
    directConsumerRows: joins.directConsumerRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 180),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: [
      "Infinity pools are bytes32 IDs in a shared manager/vault architecture, not standalone LP/pool contracts",
      "No Infinity vault, pool manager, or hook address is referenced by scanned consumer-grade artifacts",
      "Token-level matches are common-asset context and not Infinity-specific impact",
      "Vault token balances do not prove per-pool manipulability or accepted-value divergence without a consumer that reads Infinity state",
      "No exact positive borrow, redemption, liquidation, settlement, or DEX unwind economics or proof",
    ],
    requiredForRoutePositive: [
      "deployed consumer references Infinity vault, manager, hook, pool ID, or accounting state",
      "referenced state is permissionlessly movable, stale, hook-manipulable, or otherwise attacker-favorable",
      "borrow, redemption, liquidation, bridge, settlement, or unwind route is exact-quoted and positive",
      "fork/local proof",
    ],
    nextReadOnlyStep: joins.directConsumerRows.length ? "Static-review the matched Infinity consumer and exact-quote only if vault/manager/hook state affects accepted value." : "Reopen PancakeSwap Infinity only if a consumer references Infinity vault, manager, hook, pool ID, or accounting state.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`PancakeSwap Infinity Phase 0: pools=${summary.poolRows} materialTokenRows=${summary.materialTokenRows} hooks=${summary.hookRows} directConsumers=${summary.directConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
