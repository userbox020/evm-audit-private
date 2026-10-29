#!/usr/bin/env node
// scan-csigma-finance-phase0.js - read-only cSigma Finance Phase 0 scan.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, calldata, borrower addresses, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool, loadRpcUrls, PUBLIC_FALLBACKS } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "csigma-finance-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "csigma-finance-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "🟢 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const MATERIAL_USD = Number(process.env.CSIGMA_PHASE0_MATERIAL_USD || "10000");
const MAX_PAYMENT_CALLS = Number(process.env.CSIGMA_MAX_PAYMENT_CALLS || "2500");
const MAX_BALANCE_ROLE_IDS = Number(process.env.CSIGMA_MAX_BALANCE_ROLE_IDS || "1000");
const MAX_EDGE_LOG_CHUNKS = Number(process.env.CSIGMA_MAX_EDGE_LOG_CHUNKS || "90");
const MAX_PDN_LOG_CHUNKS = Number(process.env.CSIGMA_MAX_PDN_LOG_CHUNKS || "80");
const LOG_TIMEOUT_MS = Number(process.env.CSIGMA_LOG_TIMEOUT_MS || "30000");

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = [
  {
    key: "ethereum",
    chain: "Ethereum",
    chainId: 1,
    coinSlug: "ethereum",
    logChunkBlocks: 75_000,
    institutional: { address: "0xF80bA51189763B7AC484A23f7d7695345B1149C9", startBlock: 18467881 },
    edge: { address: "0xb5337C2e320D61bE3511216b9b4d32b2c41F3e55", startBlock: 20882902 },
    tokens: {
      USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    },
  },
  {
    key: "arbitrum",
    chain: "Arbitrum",
    chainId: 42161,
    coinSlug: "arbitrum",
    logChunkBlocks: 1_000_000,
    institutional: { address: "0x45dCf4F9d1B47C138Bc1E490a878790932d66caf", startBlock: 188232859 },
    edge: { address: "0x4C28F5c87e5557db971c9a2F862BfdCf9f561Bd4", startBlock: 273904688 },
    pdn: { address: "0x67A1fc35961dD0E293BB4481b48491aDF95b1395", startBlock: 218221531 },
    tokens: {
      USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
  },
  {
    key: "base",
    chain: "Base",
    chainId: 8453,
    coinSlug: "base",
    logChunkBlocks: 500_000,
    institutional: { address: "0x07D7bf6dCc4A2f03E82E3da52eBfBAe871443322", startBlock: 23596015 },
    edge: { address: "0xe76C20761BFCD471196bB61f68250DAf3dA3568B", startBlock: 23604031 },
    tokens: {
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    },
  },
  {
    key: "hedera",
    chain: "Hedera",
    chainId: 295,
    coinSlug: "hedera",
    institutional: { address: "0xF80bA51189763B7AC484A23f7d7695345B1149C9", startBlock: 84085356 },
    edge: { address: "0x78B17FbE17925622139382FE7809A9D687C5e7Bd", startBlock: 84093455 },
    unsupportedReason: "Hedera is adapter context only in current EVM RPC-supported scope",
  },
];

const VAULTS = [
  { product: "csUSD", chainId: 1, chain: "Ethereum", vault: "0xd5d097f278a735d0a3c609deee71234cac14b47e", underlyings: ["USDC"] },
  { product: "csUSD", chainId: 1, chain: "Ethereum", vault: "0xbd3f0befa86794b999b29a91d201124d8fbdf777", underlyings: ["USDT"] },
  { product: "csLYD", chainId: 1, chain: "Ethereum", vault: "0xead9190db1a6a5f4262572845cf75c31e474fd4c", underlyings: ["USDC"] },
  { product: "csLYD", chainId: 1, chain: "Ethereum", vault: "0x1922d16cc88cd60499906915b30ec891ceb6e151", underlyings: ["USDT"] },
  { product: "csUSD", chainId: 295, chain: "Hedera", vault: "0x4896a087f78E1DcB44B9231f9a6f35EA2aA0c8AC", underlyings: ["USDC"], unsupportedReason: "Hedera context-only" },
];

const INVALID_PDN_PAYMENT_IDS = new Set([
  "0x99460d3affdd3d92b7947811ee9d3081c9c2f0a9d0ee9b30af2d842f4423dd83",
  "0x0d299443084dc8cc186ef3b641a82b05067687b94c03317345c3b2f25847de38",
  "0x2f795b76f222b3e7a5bdf6e03f34972a72ff55ee893e70af58e638e7fb3a24d2",
  "0x25faefe8041a9e5e6da9bea88c188c3bd563e09b3db3515034ecf54dbfd77eed",
  "0xe206373ef521d6a43c1501252d4b93a77ca2c73219645561d93f8c1285ace4e3",
  "0xf7105def091d0d87b5ec278b039017addf64a8c16f405adccd58204a20ee9f75",
  "0x95487262748ad72d4ce68ef6df658e88c4194d4752d9d1c9f34994f41f047255",
  "0x732e6bb2ec07cfaa156fbe35e1e5240e129ac568eb2df4e343497c9c7500113c",
]);

const LOCAL_ARTIFACTS = [
  { source: "Aave/Euler/Silo graph", file: "reports/raw/fast/aave-euler-silo-consumer-graph.json" },
  { source: "Consumer-first high LTV", file: "reports/raw/fast/consumer-first-high-ltv-collateral.json" },
  { source: "RWA/NAV consumer graph", file: "reports/raw/fast/rwa-nav-consumer-graph.json" },
  { source: "Focused Morpho producers", file: "reports/raw/fast/focused-morpho-review-producers.json" },
  { source: "Focused Euler producers", file: "reports/raw/fast/focused-euler-evk-review-producers.json" },
  { source: "Morpho Pyth unsafe consumers", file: "reports/raw/fast/morpho-pyth-unsafe-consumers.json" },
  { source: "Morpho public allocator", file: "reports/raw/fast/morpho-public-allocator-force-feed.json" },
  { source: "Morpho liquidatable", file: "reports/raw/fast/morpho-liquidatable-marketability.json" },
  { source: "Morpho wrapper exit", file: "reports/raw/fast/morpho-wrapper-exit-proof-gaps.json" },
  { source: "ERC4626 consumer", file: "reports/raw/fast/erc4626-consumer-joiner.json" },
  { source: "EVault NAV", file: "reports/raw/fast/evault-collateral-nav-manipulation.json" },
  { source: "Pendle PT", file: "reports/raw/fast/pendle-pt-multichain-consumer-graph.json" },
  { source: "Pool-share snapshot", file: "reports/raw/fast/pool-share-snapshot-drift.json" },
  { source: "Public lead consumers", file: "reports/raw/fast/public-lead-consumer-joins.json" },
  { source: "Dex consumer routes", file: "reports/raw/fast/dex-consumer-routes.json" },
  { source: "Stablecoin depeg routes", file: "reports/raw/fast/stablecoin-depeg-lending-routes.json" },
  { source: "Bridge synthetic consumers", file: "reports/raw/fast/bridge-synthetic-consumer-exposure.json" },
];
const DIRECT_JOIN_ROLES = new Set(["edgePool", "poolToken", "vault", "institutionalFactory", "edgeFactory", "pdnContract"]);

const FACTORY_IFACE = new ethers.Interface([
  "function getLastPaymentId() view returns (uint256)",
  "function getPayment(string _paymentId) view returns (tuple(string roleId,string creditPoolId,uint8 paymentType,uint64 timeStamp,address from,address to,uint256 amount))",
  "function getPoolToken(string _poolId) view returns (address)",
  "function getTokenBalance(string _roleId,address _token) view returns (uint256)",
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
]);
const EDGE_IFACE = new ethers.Interface([
  "event PoolCreated(address _pool,address indexed _poolManager,address _fundManager,address indexed _poolToken,address indexed _oracleManager,uint256 _poolAPY,uint256 _poolSize)",
  "function poolToken() view returns (address)",
  "function asset() view returns (address)",
  "function token() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function admin() view returns (address)",
]);
const PDN_IFACE = new ethers.Interface([
  "event PaymentAdded(string indexed _paymentId,string _lenderId,string _poolId,uint256 _principal,uint256 _coupon,uint8 _paymentType,uint64 _timeStamp)",
]);
const ERC20_IFACE = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const BYTES32_TOKEN_IFACE = new ethers.Interface([
  "function symbol() view returns (bytes32)",
  "function name() view returns (bytes32)",
]);
const BEACON_IFACE = new ethers.Interface(["function implementation() view returns (address)"]);

const SELECTOR_SIGS = {
  supplyRedeem: ["deposit(uint256,address)", "deposit(uint256,address,address)", "withdraw(uint256,address,address)", "redeem(uint256,address,address)", "mint(uint256)", "requestRedeem(uint256)", "claim(uint256)"],
  borrowRepay: ["borrow(uint256)", "borrow(address,uint256)", "repay(uint256)", "repayBorrow(uint256)", "repay(address,uint256)"],
  liquidate: ["liquidate(address,uint256)", "liquidate(address,address,uint256)", "liquidateBorrow(address,uint256,address)", "seize(address,address,uint256)"],
  oracle: ["getPrice(address)", "price()(uint256)", "latestRoundData()", "updatePrice(address,uint256)"],
  admin: ["pause()", "unpause()", "setPaused(bool)", "setOracle(address)", "setPoolToken(string,address)", "upgradeTo(address)", "setPoolSize(uint256)"],
};

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, jsonReplacer, 2)}\n`); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function safeText(value, max = 180) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function asNumber(value) { if (value === null || value === undefined || value === "") return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unitsToNumber(raw, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(raw), Number(decimals ?? 18))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function hexBlock(value) { return `0x${Math.max(0, Number(value) || 0).toString(16)}`; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function formatNumber(value, decimals = 4) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: decimals }); }
function decodeBytes32String(value) { try { return value && value !== "0x" ? safeText(ethers.decodeBytes32String(value), 64) : null; } catch (_) { return null; } }
function slotAddress(raw) { const hex = strip0x(raw || "").padStart(64, "0"); if (!hex || /^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }
function stablePrice(symbol) { return ["USDC", "USDT", "DAI", "USDS", "USDE", "USD"].includes(String(symbol || "").toUpperCase()) ? 1 : null; }
function stableDecimals(symbol) { return ["USDC", "USDT"].includes(String(symbol || "").toUpperCase()) ? 6 : 18; }
function isCommonStable(symbol) { return ["USDC", "USDT", "USD₮0", "USDT0", "DAI", "USDS", "USDE", "USD"].includes(String(symbol || "").toUpperCase()); }
function sumUsd(rows, field) { return round(rows.reduce((acc, row) => acc + (asNumber(row[field]) || 0), 0), 2); }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-csigma-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 10_000) {
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

async function latestBlock(rpc) {
  const hex = await rpcCall(rpc, "eth_blockNumber", [], 10_000).catch(() => null);
  return hex ? parseInt(hex, 16) : null;
}

async function storageAddress(rpc, address, slot) {
  const raw = await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null);
  return slotAddress(raw);
}

async function proxyMeta(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return {};
  const [impl, admin, beacon] = await Promise.all([
    storageAddress(rpc, addr, EIP1967_IMPL),
    storageAddress(rpc, addr, EIP1967_ADMIN),
    storageAddress(rpc, addr, EIP1967_BEACON),
  ]);
  const beaconImpl = beacon ? await safeCall(rpc, beacon, BEACON_IFACE, "implementation") : null;
  return { eip1967Implementation: impl, eip1967Admin: admin, eip1967Beacon: beacon, eip1967BeaconImplementation: normalizeAddress(beaconImpl?.[0]) };
}

function selectorHits(code) {
  const body = strip0x(code).toLowerCase();
  const out = {};
  for (const [group, sigs] of Object.entries(SELECTOR_SIGS)) {
    const hits = [];
    for (const sig of sigs) {
      const sel = ethers.id(sig).slice(2, 10).toLowerCase();
      if (body.includes(sel)) hits.push(sig);
    }
    out[group] = hits;
  }
  return out;
}

async function tokenMeta(rpc, token, fallback = {}) {
  const address = normalizeAddress(token);
  if (!address) return { address: null, symbol: fallback.symbol || null, name: fallback.name || null, decimals: fallback.decimals ?? 18, codePresent: false };
  const [code, symbol, symbolB32, name, nameB32, decimals, totalSupply] = await Promise.all([
    getCode(rpc, address),
    safeCall(rpc, address, ERC20_IFACE, "symbol"),
    safeCall(rpc, address, BYTES32_TOKEN_IFACE, "symbol"),
    safeCall(rpc, address, ERC20_IFACE, "name"),
    safeCall(rpc, address, BYTES32_TOKEN_IFACE, "name"),
    safeCall(rpc, address, ERC20_IFACE, "decimals"),
    safeCall(rpc, address, ERC20_IFACE, "totalSupply"),
  ]);
  return {
    address,
    symbol: safeText(symbol?.[0], 40) || decodeBytes32String(symbolB32?.[0]) || fallback.symbol || "UNKNOWN",
    name: safeText(name?.[0], 100) || decodeBytes32String(nameB32?.[0]) || fallback.name || null,
    decimals: decimals?.[0] === undefined ? Number(fallback.decimals ?? 18) : Number(decimals[0]),
    totalSupplyRaw: totalSupply?.[0]?.toString?.() || null,
    totalSupply: totalSupply?.[0] === undefined ? null : round(unitsToNumber(totalSupply[0], decimals?.[0] ?? fallback.decimals ?? 18), 8),
    codePresent: code.length > 10,
    codeBytes: code.length > 10 ? Math.floor((code.length - 2) / 2) : 0,
  };
}

async function tokenBalance(rpc, token, owner) {
  const res = await safeCall(rpc, token, ERC20_IFACE, "balanceOf", [owner]);
  return res?.[0] === undefined ? 0n : toBig(res[0]);
}

async function contractMeta(rpc, address) {
  const addr = normalizeAddress(address);
  const code = addr ? await getCode(rpc, addr) : "0x";
  return {
    address: addr,
    codePresent: code.length > 10,
    codeBytes: code.length > 10 ? Math.floor((code.length - 2) / 2) : 0,
    proxy: code.length > 10 ? await proxyMeta(rpc, addr) : {},
    selectorHits: code.length > 10 ? selectorHits(code) : {},
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (index < items.length) {
      const i = index++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function publicMetadata() {
  const live = await fetchJson("https://api.llama.fi/protocol/csigma-finance", 40_000);
  const discovery = readJson(PUBLIC_TARGETS, {});
  const rows = [
    ...(discovery.phase0Queue || []),
    ...(discovery.protocolCandidates || []),
    ...(discovery.targetedRefreshQueue || []),
    ...(discovery.consumerJoinFirst || []),
  ];
  const row = rows.find((p) => p?.slug === "csigma-finance" || p?.name === "cSigma Finance");
  const tvlSeries = Array.isArray(live?.tvl) ? live.tvl : [];
  const tvlUsd = round(tvlSeries.length ? tvlSeries.at(-1)?.totalLiquidityUSD : row?.tvlUsd, 2);
  const chainTvls = {};
  const current = live?.currentChainTvls || {};
  for (const chain of unique([...(live?.chains || []), ...Object.keys(current), ...(row?.chains || [])])) {
    const n = asNumber(current[chain]);
    if (n !== null) chainTvls[chain] = round(n, 2);
  }
  return {
    name: live?.name || row?.name || "cSigma Finance",
    slug: live?.slug || row?.slug || "csigma-finance",
    category: live?.category || row?.category || "RWA Lending",
    chains: live?.chains || row?.chains || ["Arbitrum", "Ethereum", "Hedera", "Base"],
    evmChains: row?.evmChains || ["Arbitrum", "Ethereum", "Base"],
    tvlUsd,
    chainTvls,
    audits: live?.audit_links || live?.audits || row?.audits || [],
    url: live?.url || row?.url || null,
    twitter: live?.twitter || row?.twitter || null,
    module: live?.module || "csigma-finance/index.js",
    tvlCodePath: live?.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/csigma-finance/index.js",
    methodology: safeText(live?.methodology || live?.description || "DefiLlama adapter sums institutional pools, Edge pools, Private Debt Network investments, and csUSD/csLYD vault balances.", 320),
    change1dPct: row?.change1dPct ?? live?.change_1d ?? null,
    change7dPct: row?.change7dPct ?? live?.change_7d ?? null,
    routePriority: row?.routePriority || null,
    sourceAvailability: "DefiLlama adapter plus live bytecode; no source repo cloned in this bounded Phase 0 pass",
  };
}

async function getLogsChunked(rpc, params, fromBlock, latest, chunkBlocks, maxChunks) {
  if (!rpc || !fromBlock || !latest || fromBlock > latest) return { logs: [], errors: [], chunks: 0, rangeCapped: false };
  const span = latest - fromBlock + 1;
  const chunk = Math.max(1, chunkBlocks || Math.ceil(span / Math.max(1, maxChunks)) || 100_000);
  const logs = [];
  const errors = [];
  let chunks = 0;
  async function fetchRange(from, to, depth = 0) {
    chunks++;
    const res = await rpcCall(rpc, "eth_getLogs", [{ ...params, fromBlock: hexBlock(from), toBlock: hexBlock(to) }], LOG_TIMEOUT_MS).catch(() => null);
    if (Array.isArray(res)) {
      logs.push(...res);
      return;
    }
    if (to > from && to - from + 1 > 5_000 && depth < 8) {
      const mid = Math.floor((from + to) / 2);
      await fetchRange(from, mid, depth + 1);
      await fetchRange(mid + 1, to, depth + 1);
      return;
    }
    if (errors.length < 24) errors.push({ fromBlock: from, toBlock: to, reason: "eth_getLogs returned no array" });
  }
  for (let from = fromBlock; from <= latest; from += chunk) {
    const to = Math.min(latest, from + chunk - 1);
    await fetchRange(from, to);
  }
  return { logs, errors, chunks, rangeCapped: false };
}

async function resolveLogCapableRpc(chain) {
  if (!chain?.chainId || !chain?.edge?.address || !chain?.edge?.startBlock) return null;
  const pool = [...loadRpcUrls(), PUBLIC_FALLBACKS[chain.chainId]].filter(Boolean);
  const topic = ethers.id("PoolCreated(address,address,address,address,address,uint256,uint256)");
  const from = chain.edge.startBlock;
  const to = from + Math.min(100_000, Math.max(1000, chain.logChunkBlocks || 100_000));
  for (const url of pool) {
    const id = await rpcCall(url, "eth_chainId", [], 4000).catch(() => null);
    if (!id || parseInt(id, 16) !== chain.chainId) continue;
    const logs = await rpcCall(url, "eth_getLogs", [{ address: normalizeAddress(chain.edge.address), fromBlock: hexBlock(from), toBlock: hexBlock(to), topics: [topic] }], 12_000).catch(() => null);
    if (Array.isArray(logs)) return url;
  }
  return null;
}

function decodePoolCreated(log, chain) {
  try {
    const parsed = EDGE_IFACE.parseLog({ topics: log.topics || [], data: log.data || "0x" });
    return {
      chain: chain.chain,
      chainId: chain.chainId,
      edgeFactory: normalizeAddress(chain.edge.address),
      blockNumber: Number(log.blockNumber || 0),
      txHash: safeText(log.transactionHash, 80),
      pool: normalizeAddress(parsed.args._pool),
      poolManager: normalizeAddress(parsed.args._poolManager),
      fundManager: normalizeAddress(parsed.args._fundManager),
      poolToken: normalizeAddress(parsed.args._poolToken),
      oracleManager: normalizeAddress(parsed.args._oracleManager),
      poolApyRaw: parsed.args._poolAPY?.toString?.() || null,
      poolSizeRaw: parsed.args._poolSize?.toString?.() || null,
    };
  } catch (_) { return null; }
}

function decodePdnPayment(log, chain) {
  try {
    const parsed = PDN_IFACE.parseLog({ topics: log.topics || [], data: log.data || "0x" });
    const paymentIdHash = parsed.args._paymentId?.hash || parsed.args._paymentId;
    if (INVALID_PDN_PAYMENT_IDS.has(String(paymentIdHash || "").toLowerCase())) return null;
    return {
      chain: chain.chain,
      chainId: chain.chainId,
      blockNumber: Number(log.blockNumber || 0),
      paymentIdHash: safeText(paymentIdHash, 80),
      paymentType: Number(parsed.args._paymentType),
      principalRaw: parsed.args._principal?.toString?.() || "0",
      couponRaw: parsed.args._coupon?.toString?.() || "0",
      timestamp: Number(parsed.args._timeStamp || 0),
    };
  } catch (_) { return null; }
}

async function scanInstitutional(rpc, chain, factoryMeta) {
  const factory = normalizeAddress(chain.institutional.address);
  if (!rpc || !factory || !factoryMeta.codePresent) {
    return { chain: chain.chain, chainId: chain.chainId, factory, codePresent: factoryMeta.codePresent, paymentsScanned: 0, scanCapped: false, poolTokenRows: [], tokenBalanceRows: [], paymentCounts: {}, netInvestmentUsd: null, logError: factoryMeta.codePresent ? null : "factory code missing" };
  }
  const lastPayment = await safeCall(rpc, factory, FACTORY_IFACE, "getLastPaymentId", [], 15_000);
  const lastPaymentId = lastPayment?.[0] === undefined ? null : Number(lastPayment[0]);
  if (!Number.isFinite(lastPaymentId)) {
    return { chain: chain.chain, chainId: chain.chainId, factory, codePresent: true, paymentsScanned: 0, scanCapped: false, poolTokenRows: [], tokenBalanceRows: [], paymentCounts: {}, netInvestmentUsd: null, logError: "getLastPaymentId unavailable" };
  }
  const count = Math.max(0, lastPaymentId + 1);
  const scanCount = Math.min(count, MAX_PAYMENT_CALLS);
  const scanCapped = scanCount < count;
  const ids = Array.from({ length: scanCount }, (_, i) => String(i));
  const decoded = (await mapLimit(ids, 12, async (id) => {
    const res = await safeCall(rpc, factory, FACTORY_IFACE, "getPayment", [id], 15_000);
    const p = res?.[0];
    if (!p) return null;
    return {
      paymentType: Number(p.paymentType ?? p[2]),
      creditPoolId: String(p.creditPoolId ?? p[1] ?? ""),
      roleId: String(p.roleId ?? p[0] ?? ""),
      amountRaw: toBig(p.amount ?? p[6]).toString(),
      from: normalizeAddress(p.from ?? p[4]),
      to: normalizeAddress(p.to ?? p[5]),
      timestamp: Number(p.timeStamp ?? p[3] ?? 0),
    };
  })).filter(Boolean);
  const paymentCounts = {};
  for (const p of decoded) paymentCounts[p.paymentType] = (paymentCounts[p.paymentType] || 0) + 1;
  const poolIds = unique(decoded.filter((p) => p.creditPoolId).map((p) => p.creditPoolId));
  const poolTokenResults = await mapLimit(poolIds, 10, async (poolId) => {
    const res = await safeCall(rpc, factory, FACTORY_IFACE, "getPoolToken", [poolId], 12_000);
    return normalizeAddress(res?.[0]);
  });
  const poolById = new Map();
  poolIds.forEach((id, i) => { if (poolTokenResults[i]) poolById.set(id, poolTokenResults[i]); });
  const tokenMetas = new Map();
  for (const token of unique([...poolById.values()])) tokenMetas.set(lowerAddress(token), await tokenMeta(rpc, token));
  const netByToken = new Map();
  const investments = decoded.filter((p) => p.paymentType === 0 && p.creditPoolId);
  const investmentRoleIds = new Set(investments.map((p) => p.roleId).filter(Boolean));
  const principalPaid = decoded.filter((p) => (p.paymentType === 5 || p.paymentType === 6) && p.creditPoolId && investmentRoleIds.has(p.roleId));
  for (const p of investments) {
    const token = poolById.get(p.creditPoolId);
    if (!token) continue;
    const key = lowerAddress(token);
    netByToken.set(key, (netByToken.get(key) || 0n) + toBig(p.amountRaw));
  }
  for (const p of principalPaid) {
    const token = poolById.get(p.creditPoolId);
    if (!token) continue;
    const key = lowerAddress(token);
    netByToken.set(key, (netByToken.get(key) || 0n) - toBig(p.amountRaw));
  }
  const poolTokenRows = [...netByToken.entries()].map(([key, raw]) => {
    const meta = tokenMetas.get(key) || { address: key, symbol: "UNKNOWN", decimals: 18 };
    const amount = unitsToNumber(raw, meta.decimals);
    const price = stablePrice(meta.symbol);
    return {
      chain: chain.chain,
      chainId: chain.chainId,
      factory,
      token: meta.address,
      symbol: meta.symbol,
      decimals: meta.decimals,
      netInvestmentRaw: raw.toString(),
      netInvestment: round(amount, 8),
      netInvestmentUsd: price === null || amount === null ? null : round(amount * price, 2),
      routePositive: false,
    };
  });
  const lenderIds = unique(decoded.filter((p) => p.paymentType === 2 && p.roleId).map((p) => p.roleId)).slice(0, MAX_BALANCE_ROLE_IDS);
  const stableTokens = [chain.tokens?.USDC, chain.tokens?.USDT].filter(Boolean);
  const balanceCalls = [];
  for (const roleId of lenderIds) for (const token of stableTokens) balanceCalls.push({ roleId, token });
  const balanceResults = await mapLimit(balanceCalls, 12, async (call) => {
    const res = await safeCall(rpc, factory, FACTORY_IFACE, "getTokenBalance", [call.roleId, call.token], 12_000);
    return { token: normalizeAddress(call.token), raw: res?.[0] === undefined ? 0n : toBig(res[0]) };
  });
  const balanceByToken = new Map();
  for (const row of balanceResults) {
    const key = lowerAddress(row.token);
    if (!key) continue;
    balanceByToken.set(key, (balanceByToken.get(key) || 0n) + row.raw);
  }
  const tokenBalanceRows = [];
  for (const [key, raw] of balanceByToken.entries()) {
    const symbol = Object.entries(chain.tokens || {}).find(([, addr]) => lowerAddress(addr) === key)?.[0] || "UNKNOWN";
    const decimals = stableDecimals(symbol);
    const amount = unitsToNumber(raw, decimals);
    tokenBalanceRows.push({ chain: chain.chain, chainId: chain.chainId, factory, token: normalizeAddress(key), symbol, scannedRoleIds: lenderIds.length, balanceRaw: raw.toString(), balance: round(amount, 8), balanceUsd: amount === null ? null : round(amount, 2), routePositive: false });
  }
  return {
    chain: chain.chain,
    chainId: chain.chainId,
    factory,
    startBlock: chain.institutional.startBlock,
    codePresent: true,
    codeBytes: factoryMeta.codeBytes,
    proxy: factoryMeta.proxy,
    selectorHits: factoryMeta.selectorHits,
    lastPaymentId,
    paymentsAvailable: count,
    paymentsScanned: decoded.length,
    scanCapped,
    paymentCounts,
    uniquePoolIds: poolIds.length,
    uniquePoolTokens: poolTokenRows.length,
    lenderRoleIdsScanned: lenderIds.length,
    poolTokenRows,
    tokenBalanceRows,
    netInvestmentUsd: sumUsd(poolTokenRows, "netInvestmentUsd"),
    lenderTokenBalanceUsd: sumUsd(tokenBalanceRows, "balanceUsd"),
    routePositive: false,
  };
}

async function scanEdge(rpc, chain, factoryMeta, latest) {
  const factory = normalizeAddress(chain.edge.address);
  if (!rpc || !factory || !factoryMeta.codePresent) {
    return { chain: chain.chain, chainId: chain.chainId, factory, codePresent: factoryMeta.codePresent, poolEvents: 0, poolRows: [], logErrors: factoryMeta.codePresent ? [] : [{ reason: "factory code missing" }], logChunks: 0, routePositive: false };
  }
  const topic = ethers.id("PoolCreated(address,address,address,address,address,uint256,uint256)");
  const logs = await getLogsChunked(rpc, { address: factory, topics: [topic] }, chain.edge.startBlock, latest, chain.logChunkBlocks, MAX_EDGE_LOG_CHUNKS);
  const decodedEvents = logs.logs.map((log) => decodePoolCreated(log, chain)).filter(Boolean);
  const byPool = new Map();
  for (const event of decodedEvents) if (event.pool && !byPool.has(lowerAddress(event.pool))) byPool.set(lowerAddress(event.pool), event);
  const poolRows = await mapLimit([...byPool.values()], 10, async (event) => {
    const [poolMeta, eventTokenMeta, poolTokenCall, assetCall, tokenCall] = await Promise.all([
      contractMeta(rpc, event.pool),
      tokenMeta(rpc, event.poolToken),
      safeCall(rpc, event.pool, EDGE_IFACE, "poolToken"),
      safeCall(rpc, event.pool, EDGE_IFACE, "asset"),
      safeCall(rpc, event.pool, EDGE_IFACE, "token"),
    ]);
    const poolToken = normalizeAddress(poolTokenCall?.[0]) || event.poolToken;
    const asset = normalizeAddress(assetCall?.[0]) || normalizeAddress(tokenCall?.[0]) || poolToken;
    const assetMeta = lowerAddress(asset) === lowerAddress(event.poolToken) ? eventTokenMeta : await tokenMeta(rpc, asset);
    const [poolBalanceRaw, fundManagerBalanceRaw, totalAssets, maxWithdraw, maxRedeem, maxDeposit, paused] = await Promise.all([
      poolToken ? tokenBalance(rpc, poolToken, event.pool) : Promise.resolve(0n),
      poolToken && event.fundManager ? tokenBalance(rpc, poolToken, event.fundManager) : Promise.resolve(0n),
      safeCall(rpc, event.pool, EDGE_IFACE, "totalAssets"),
      event.fundManager ? safeCall(rpc, event.pool, EDGE_IFACE, "maxWithdraw", [event.fundManager]) : Promise.resolve(null),
      event.fundManager ? safeCall(rpc, event.pool, EDGE_IFACE, "maxRedeem", [event.fundManager]) : Promise.resolve(null),
      event.fundManager ? safeCall(rpc, event.pool, EDGE_IFACE, "maxDeposit", [event.fundManager]) : Promise.resolve(null),
      safeCall(rpc, event.pool, EDGE_IFACE, "paused"),
    ]);
    const decimals = assetMeta.decimals ?? eventTokenMeta.decimals ?? 18;
    const price = stablePrice(assetMeta.symbol || eventTokenMeta.symbol);
    const poolBalance = unitsToNumber(poolBalanceRaw, decimals);
    const fundManagerBalance = unitsToNumber(fundManagerBalanceRaw, decimals);
    const totalAssetsAmount = totalAssets?.[0] === undefined ? null : unitsToNumber(totalAssets[0], decimals);
    const poolSize = event.poolSizeRaw === null ? null : unitsToNumber(event.poolSizeRaw, decimals);
    const balanceUsd = price === null ? null : round(((poolBalance || 0) + (fundManagerBalance || 0)), 2);
    return {
      ...event,
      poolCodePresent: poolMeta.codePresent,
      poolCodeBytes: poolMeta.codeBytes,
      poolProxy: poolMeta.proxy,
      selectorHits: poolMeta.selectorHits,
      poolToken,
      poolTokenCodePresent: eventTokenMeta.codePresent,
      symbol: assetMeta.symbol || eventTokenMeta.symbol,
      name: assetMeta.name || eventTokenMeta.name,
      decimals,
      totalSupply: eventTokenMeta.totalSupply,
      poolBalanceRaw: poolBalanceRaw.toString(),
      fundManagerBalanceRaw: fundManagerBalanceRaw.toString(),
      poolBalance: round(poolBalance, 8),
      fundManagerBalance: round(fundManagerBalance, 8),
      balanceUsd,
      totalAssetsRaw: totalAssets?.[0]?.toString?.() || null,
      totalAssets: round(totalAssetsAmount, 8),
      totalAssetsUsd: price === null || totalAssetsAmount === null ? null : round(totalAssetsAmount, 2),
      poolSize: round(poolSize, 8),
      poolSizeUsd: price === null || poolSize === null ? null : round(poolSize, 2),
      maxWithdrawRaw: maxWithdraw?.[0]?.toString?.() || null,
      maxRedeemRaw: maxRedeem?.[0]?.toString?.() || null,
      maxDepositRaw: maxDeposit?.[0]?.toString?.() || null,
      paused: paused?.[0] === undefined ? null : Boolean(paused[0]),
      routePositive: false,
    };
  });
  return {
    chain: chain.chain,
    chainId: chain.chainId,
    factory,
    startBlock: chain.edge.startBlock,
    codePresent: true,
    codeBytes: factoryMeta.codeBytes,
    proxy: factoryMeta.proxy,
    selectorHits: factoryMeta.selectorHits,
    logChunks: logs.chunks,
    logErrors: logs.errors,
    logErrorCount: logs.errors.length,
    poolEvents: decodedEvents.length,
    poolRows,
    routePositive: false,
  };
}

async function scanPdn(rpc, chain, contractMetaRow, latest) {
  if (!chain.pdn) return null;
  const contract = normalizeAddress(chain.pdn.address);
  if (!rpc || !contract || !contractMetaRow.codePresent) return { chain: chain.chain, chainId: chain.chainId, contract, codePresent: contractMetaRow.codePresent, logsDecoded: 0, logErrors: contractMetaRow.codePresent ? [] : [{ reason: "contract code missing" }], netInvestmentUsd: null, routePositive: false };
  const topic = ethers.id("PaymentAdded(string,string,string,uint256,uint256,uint8,uint64)");
  const logs = await getLogsChunked(rpc, { address: contract, topics: [topic] }, chain.pdn.startBlock, latest, chain.logChunkBlocks, MAX_PDN_LOG_CHUNKS);
  const payments = logs.logs.map((log) => decodePdnPayment(log, chain)).filter(Boolean);
  const totalInvestmentsRaw = payments.filter((p) => p.paymentType === 0).reduce((acc, p) => acc + toBig(p.principalRaw), 0n);
  const totalPaymentsRaw = payments.filter((p) => p.paymentType === 1).reduce((acc, p) => acc + toBig(p.principalRaw), 0n);
  const netRaw = totalInvestmentsRaw - totalPaymentsRaw;
  const netUsd = Number(netRaw) / 100;
  const typeCounts = {};
  for (const p of payments) typeCounts[p.paymentType] = (typeCounts[p.paymentType] || 0) + 1;
  return {
    chain: chain.chain,
    chainId: chain.chainId,
    contract,
    startBlock: chain.pdn.startBlock,
    codePresent: true,
    codeBytes: contractMetaRow.codeBytes,
    proxy: contractMetaRow.proxy,
    selectorHits: contractMetaRow.selectorHits,
    logChunks: logs.chunks,
    logErrors: logs.errors,
    logErrorCount: logs.errors.length,
    logsDecoded: payments.length,
    paymentTypeCounts: typeCounts,
    totalInvestmentsUsd: round(Number(totalInvestmentsRaw) / 100, 2),
    totalPaymentsUsd: round(Number(totalPaymentsRaw) / 100, 2),
    netInvestmentUsd: round(netUsd, 2),
    routePositive: false,
  };
}

async function scanVaults(rpcs) {
  const rows = [];
  for (const vault of VAULTS) {
    const chain = CHAINS.find((c) => c.chainId === vault.chainId);
    if (vault.unsupportedReason || !chain || !rpcs[vault.chainId]) {
      rows.push({ product: vault.product, chain: vault.chain, chainId: vault.chainId, vault: normalizeAddress(vault.vault), codePresent: false, unsupportedReason: vault.unsupportedReason || "RPC unsupported in current scope", routePositive: false });
      continue;
    }
    const rpc = rpcs[vault.chainId];
    const meta = await contractMeta(rpc, vault.vault);
    const underlyings = [];
    for (const symbol of vault.underlyings) {
      const token = chain.tokens?.[symbol];
      const tokenInfo = await tokenMeta(rpc, token, { symbol, decimals: stableDecimals(symbol) });
      const balanceRaw = await tokenBalance(rpc, token, vault.vault);
      const amount = unitsToNumber(balanceRaw, tokenInfo.decimals);
      underlyings.push({ token: tokenInfo.address, symbol: tokenInfo.symbol || symbol, decimals: tokenInfo.decimals, balanceRaw: balanceRaw.toString(), balance: round(amount, 8), balanceUsd: amount === null ? null : round(amount, 2) });
    }
    const ercMeta = await tokenMeta(rpc, vault.vault, { symbol: vault.product, decimals: 18 });
    const [asset, totalAssets, maxDeposit, maxWithdraw, maxRedeem, paused] = await Promise.all([
      safeCall(rpc, vault.vault, EDGE_IFACE, "asset"),
      safeCall(rpc, vault.vault, EDGE_IFACE, "totalAssets"),
      safeCall(rpc, vault.vault, EDGE_IFACE, "maxDeposit", [ZERO]),
      safeCall(rpc, vault.vault, EDGE_IFACE, "maxWithdraw", [ZERO]),
      safeCall(rpc, vault.vault, EDGE_IFACE, "maxRedeem", [ZERO]),
      safeCall(rpc, vault.vault, EDGE_IFACE, "paused"),
    ]);
    const totalAssetsAmount = totalAssets?.[0] === undefined ? null : unitsToNumber(totalAssets[0], ercMeta.decimals);
    rows.push({
      product: vault.product,
      chain: vault.chain,
      chainId: vault.chainId,
      vault: normalizeAddress(vault.vault),
      codePresent: meta.codePresent,
      codeBytes: meta.codeBytes,
      proxy: meta.proxy,
      selectorHits: meta.selectorHits,
      symbol: ercMeta.symbol,
      name: ercMeta.name,
      decimals: ercMeta.decimals,
      totalSupply: ercMeta.totalSupply,
      asset: normalizeAddress(asset?.[0]),
      totalAssetsRaw: totalAssets?.[0]?.toString?.() || null,
      totalAssets: round(totalAssetsAmount, 8),
      totalAssetsUsd: totalAssetsAmount === null ? null : round(totalAssetsAmount, 2),
      maxDepositRaw: maxDeposit?.[0]?.toString?.() || null,
      maxWithdrawRaw: maxWithdraw?.[0]?.toString?.() || null,
      maxRedeemRaw: maxRedeem?.[0]?.toString?.() || null,
      paused: paused?.[0] === undefined ? null : Boolean(paused[0]),
      underlyings,
      balanceUsd: sumUsd(underlyings, "balanceUsd"),
      routePositive: false,
    });
  }
  return rows;
}

function findLocalArtifactJoins(addressRows) {
  const rows = [];
  for (const { source, file } of LOCAL_ARTIFACTS) {
    const rel = file;
    const text = readText(path.join(WORKSPACE, file)).toLowerCase();
    if (!text) continue;
    for (const row of addressRows) {
      const addr = lowerAddress(row.address);
      if (!addr || !text.includes(addr)) continue;
      const commonStableContext = ["poolToken", "institutionalPoolToken", "vaultUnderlying"].includes(row.role) && isCommonStable(row.symbol);
      rows.push({ source, artifact: rel, chain: row.chain, role: row.role, address: row.address, symbol: row.symbol || null, direct: DIRECT_JOIN_ROLES.has(row.role) && !commonStableContext, commonStableContext, routePositive: false });
    }
  }
  return rows;
}

function buildAddressRows(chainRows, institutionalRows, edgeRows, vaultRows, pdnRows) {
  const rows = [];
  for (const c of chainRows) {
    if (c.institutionalFactory) rows.push({ chain: c.chain, role: "institutionalFactory", address: c.institutionalFactory });
    if (c.edgeFactory) rows.push({ chain: c.chain, role: "edgeFactory", address: c.edgeFactory });
  }
  for (const pdn of pdnRows.filter(Boolean)) if (pdn.contract) rows.push({ chain: pdn.chain, role: "pdnContract", address: pdn.contract });
  for (const inst of institutionalRows) {
    for (const token of inst.poolTokenRows || []) rows.push({ chain: token.chain, role: "institutionalPoolToken", address: token.token, symbol: token.symbol });
  }
  for (const edge of edgeRows) {
    for (const pool of edge.poolRows || []) {
      rows.push({ chain: pool.chain, role: "edgePool", address: pool.pool, symbol: pool.symbol });
      rows.push({ chain: pool.chain, role: "poolToken", address: pool.poolToken, symbol: pool.symbol });
      rows.push({ chain: pool.chain, role: "oracleManager", address: pool.oracleManager });
      rows.push({ chain: pool.chain, role: "fundManager", address: pool.fundManager });
    }
  }
  for (const vault of vaultRows) {
    rows.push({ chain: vault.chain, role: "vault", address: vault.vault, symbol: vault.symbol || vault.product });
    for (const u of vault.underlyings || []) rows.push({ chain: vault.chain, role: "vaultUnderlying", address: u.token, symbol: u.symbol });
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.chain}:${row.role}:${lowerAddress(row.address)}`;
    if (!row.address || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(raw) {
  const edgePools = raw.edgeRows.flatMap((r) => r.poolRows || []);
  const institutionalPoolTokens = raw.institutionalRows.flatMap((r) => r.poolTokenRows || []);
  const institutionalBalances = raw.institutionalRows.flatMap((r) => r.tokenBalanceRows || []);
  const materialEdgeRows = edgePools.filter((r) => (asNumber(r.balanceUsd) || asNumber(r.totalAssetsUsd) || asNumber(r.poolSizeUsd) || 0) >= MATERIAL_USD);
  const materialVaultRows = raw.vaultRows.filter((r) => (asNumber(r.balanceUsd) || asNumber(r.totalAssetsUsd) || 0) >= MATERIAL_USD);
  const directConsumerRows = raw.localArtifactRows.filter((r) => r.direct).length;
  const watchCandidates = raw.localArtifactRows.filter((r) => r.direct && !["vaultUnderlying", "fundManager", "oracleManager"].includes(r.role)).length;
  const contractsWithCode = [
    ...raw.chainRows.flatMap((c) => [c.institutionalFactoryCodePresent, c.edgeFactoryCodePresent]),
    ...edgePools.flatMap((p) => [p.poolCodePresent, p.poolTokenCodePresent]),
    ...raw.vaultRows.map((v) => v.codePresent),
    ...raw.pdnRows.filter(Boolean).map((p) => p.codePresent),
  ].filter(Boolean).length;
  raw.summary = {
    defillamaCurrentTvlUsd: raw.metadata.tvlUsd,
    evmChainsScoped: 3,
    chainsScanned: raw.chainRows.filter((r) => r.rpcResolved).length,
    unsupportedChains: raw.chainRows.filter((r) => !r.rpcResolved).length,
    contractsWithCode,
    institutionalFactoriesWithCode: raw.chainRows.filter((r) => r.institutionalFactoryCodePresent).length,
    edgeFactoriesWithCode: raw.chainRows.filter((r) => r.edgeFactoryCodePresent).length,
    institutionalPaymentsScanned: raw.institutionalRows.reduce((acc, r) => acc + (asNumber(r.paymentsScanned) || 0), 0),
    institutionalPaymentsAvailable: raw.institutionalRows.reduce((acc, r) => acc + (asNumber(r.paymentsAvailable) || 0), 0),
    institutionalScanCappedRows: raw.institutionalRows.filter((r) => r.scanCapped).length,
    institutionalPoolTokenRows: institutionalPoolTokens.length,
    institutionalNetInvestmentUsd: sumUsd(institutionalPoolTokens, "netInvestmentUsd"),
    institutionalLenderBalanceUsd: sumUsd(institutionalBalances, "balanceUsd"),
    edgePoolEvents: edgePools.length,
    edgePoolsWithCode: edgePools.filter((r) => r.poolCodePresent).length,
    edgePoolTokenRows: unique(edgePools.map((r) => lowerAddress(r.poolToken))).length,
    materialEdgeRows: materialEdgeRows.length,
    edgeBalanceUsd: sumUsd(edgePools, "balanceUsd"),
    edgeTotalAssetsUsd: sumUsd(edgePools, "totalAssetsUsd"),
    vaultRows: raw.vaultRows.length,
    vaultRowsWithCode: raw.vaultRows.filter((r) => r.codePresent).length,
    materialVaultRows: materialVaultRows.length,
    vaultBalanceUsd: sumUsd(raw.vaultRows, "balanceUsd"),
    pdnRows: raw.pdnRows.filter(Boolean).length,
    pdnLogsDecoded: raw.pdnRows.filter(Boolean).reduce((acc, r) => acc + (asNumber(r.logsDecoded) || 0), 0),
    pdnNetInvestmentUsd: sumUsd(raw.pdnRows.filter(Boolean), "netInvestmentUsd"),
    logErrors: raw.edgeRows.reduce((acc, r) => acc + (asNumber(r.logErrorCount) || 0), 0) + raw.pdnRows.filter(Boolean).reduce((acc, r) => acc + (asNumber(r.logErrorCount) || 0), 0),
    localArtifactRows: raw.localArtifactRows.length,
    directConsumerRows,
    tokenContextRows: raw.localArtifactRows.filter((r) => !r.direct).length,
    watchCandidates,
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
  };
}

function writeReport(raw) {
  const s = raw.summary;
  const lines = [];
  lines.push(`# ${SIGNAL_DORMANT} - cSigma Finance Phase 0`);
  lines.push("");
  lines.push(`Generated: ${raw.generatedAt}`);
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push("No permissionless route-positive exploit is claimed. The bounded pass mapped cSigma institutional factories, Edge pool factories, Arbitrum Private Debt Network logs, and csUSD/csLYD vault balances using public adapter data plus live read-only calls.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Public TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |`);
  lines.push(`| EVM chains scanned | \`${s.chainsScanned}\` |`);
  lines.push(`| Contracts with code | \`${s.contractsWithCode}\` |`);
  lines.push(`| Institutional payments scanned | \`${s.institutionalPaymentsScanned}\` |`);
  lines.push(`| Institutional pool-token rows | \`${s.institutionalPoolTokenRows}\` |`);
  lines.push(`| Institutional net investment context | ${formatUsd(s.institutionalNetInvestmentUsd)} |`);
  lines.push(`| Edge pool events | \`${s.edgePoolEvents}\` |`);
  lines.push(`| Edge pools with code | \`${s.edgePoolsWithCode}\` |`);
  lines.push(`| Material Edge rows | \`${s.materialEdgeRows}\` |`);
  lines.push(`| csUSD/csLYD vault rows with code | \`${s.vaultRowsWithCode}\` |`);
  lines.push(`| Material vault rows | \`${s.materialVaultRows}\` |`);
  lines.push(`| Arbitrum PDN logs decoded | \`${s.pdnLogsDecoded}\` |`);
  lines.push(`| Arbitrum PDN net investment context | ${formatUsd(s.pdnNetInvestmentUsd)} |`);
  lines.push(`| Local artifact joins | \`${s.localArtifactRows}\` |`);
  lines.push(`| Direct consumer joins | \`${s.directConsumerRows}\` |`);
  lines.push(`| Watch candidates | \`${s.watchCandidates}\` |`);
  lines.push(`| Route-positive | \`${s.routePositive}\` |`);
  lines.push("");
  lines.push("## Chain Coverage");
  lines.push("");
  lines.push("| Chain | RPC | Institutional factory | Edge factory | Edge pools | Log errors | Notes |");
  lines.push("|---|---:|---:|---:|---:|---:|---|");
  for (const row of raw.chainRows) {
    lines.push(`| ${row.chain} | ${row.rpcResolved ? "yes" : "no"} | ${row.institutionalFactoryCodePresent ? "yes" : "no"} | ${row.edgeFactoryCodePresent ? "yes" : "no"} | \`${row.edgePools || 0}\` | \`${row.logErrors || 0}\` | ${safeText(row.unsupportedReason || "scanned", 100)} |`);
  }
  lines.push("");
  lines.push("## Top Edge Pool Rows");
  lines.push("");
  lines.push("| Chain | Pool | Token | Balance | Total assets | Pool size | Selector hints |");
  lines.push("|---|---|---|---:|---:|---:|---|");
  const edgePools = raw.edgeRows.flatMap((r) => r.poolRows || []).sort((a, b) => (asNumber(b.balanceUsd) || asNumber(b.totalAssetsUsd) || asNumber(b.poolSizeUsd) || 0) - (asNumber(a.balanceUsd) || asNumber(a.totalAssetsUsd) || asNumber(a.poolSizeUsd) || 0));
  for (const row of edgePools.slice(0, 12)) {
    const hints = Object.entries(row.selectorHits || {}).filter(([, hits]) => hits.length).map(([k, hits]) => `${k}:${hits.length}`).join(", ") || "none";
    lines.push(`| ${row.chain} | \`${compactAddress(row.pool)}\` | ${row.symbol || "UNKNOWN"} | ${formatUsd(row.balanceUsd)} | ${formatUsd(row.totalAssetsUsd)} | ${formatUsd(row.poolSizeUsd)} | ${safeText(hints, 80)} |`);
  }
  lines.push("");
  lines.push("## Vault Rows");
  lines.push("");
  lines.push("| Chain | Product | Vault | Balance | Total assets | Status |");
  lines.push("|---|---|---|---:|---:|---|");
  for (const row of raw.vaultRows) {
    lines.push(`| ${row.chain} | ${row.product} | \`${compactAddress(row.vault)}\` | ${formatUsd(row.balanceUsd)} | ${formatUsd(row.totalAssetsUsd)} | ${safeText(row.unsupportedReason || (row.codePresent ? "code-present" : "no-code"), 80)} |`);
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const blocker of raw.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Required For Route-Positive");
  lines.push("");
  for (const req of raw.requiredForRoutePositive) lines.push(`- ${req}`);
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("");
  lines.push(raw.nextReadOnlyStep);
  lines.push("");
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, `${lines.join("\n")}\n`);
}

async function main() {
  const metadata = await publicMetadata();
  const scoped = CHAINS.filter((c) => !c.unsupportedReason);
  const rpcs = await resolveRpcPool(scoped.map((c) => c.chainId));
  for (const chain of scoped) {
    const logCapable = await resolveLogCapableRpc(chain);
    if (logCapable) rpcs[chain.chainId] = logCapable;
  }
  const chainRows = [];
  const institutionalRows = [];
  const edgeRows = [];
  const pdnRows = [];

  for (const chain of CHAINS) {
    const rpc = rpcs[chain.chainId];
    if (!rpc || chain.unsupportedReason) {
      chainRows.push({ chain: chain.chain, chainId: chain.chainId, rpcResolved: false, institutionalFactory: normalizeAddress(chain.institutional?.address), edgeFactory: normalizeAddress(chain.edge?.address), institutionalFactoryCodePresent: false, edgeFactoryCodePresent: false, edgePools: 0, logErrors: 0, unsupportedReason: chain.unsupportedReason || "No RPC resolved" });
      continue;
    }
    const latest = await latestBlock(rpc);
    const [institutionalMeta, edgeMeta, pdnMeta] = await Promise.all([
      contractMeta(rpc, chain.institutional.address),
      contractMeta(rpc, chain.edge.address),
      chain.pdn ? contractMeta(rpc, chain.pdn.address) : Promise.resolve(null),
    ]);
    const [institutional, edge, pdn] = await Promise.all([
      scanInstitutional(rpc, chain, institutionalMeta),
      scanEdge(rpc, chain, edgeMeta, latest),
      chain.pdn ? scanPdn(rpc, chain, pdnMeta, latest) : Promise.resolve(null),
    ]);
    institutionalRows.push(institutional);
    edgeRows.push(edge);
    if (pdn) pdnRows.push(pdn);
    chainRows.push({
      chain: chain.chain,
      chainId: chain.chainId,
      rpcResolved: true,
      latestBlock: latest,
      institutionalFactory: normalizeAddress(chain.institutional.address),
      institutionalStartBlock: chain.institutional.startBlock,
      institutionalFactoryCodePresent: institutionalMeta.codePresent,
      institutionalFactoryCodeBytes: institutionalMeta.codeBytes,
      edgeFactory: normalizeAddress(chain.edge.address),
      edgeStartBlock: chain.edge.startBlock,
      edgeFactoryCodePresent: edgeMeta.codePresent,
      edgeFactoryCodeBytes: edgeMeta.codeBytes,
      edgePools: edge.poolRows?.length || 0,
      edgePoolEvents: edge.poolEvents || 0,
      logChunks: edge.logChunks || 0,
      logErrors: edge.logErrorCount || 0,
      pdnContract: pdn?.contract || null,
      pdnCodePresent: pdn?.codePresent || false,
      pdnLogsDecoded: pdn?.logsDecoded || 0,
    });
  }

  const vaultRows = await scanVaults(rpcs);
  const raw = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-csigma-finance-phase0.js",
    scope: "Read-only bounded Phase 0 over cSigma institutional factories, Edge pools, PDN logs, and csUSD/csLYD vaults on Ethereum/Arbitrum/Base; Hedera context-only.",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    metadata,
    adapterSeeds: { chains: CHAINS, vaults: VAULTS, pdnInvalidPaymentIdsExcluded: INVALID_PDN_PAYMENT_IDS.size },
    chainRows,
    institutionalRows,
    edgeRows,
    pdnRows,
    vaultRows,
    localArtifactRows: [],
    blockers: [
      "Hedera adapter deployment is context-only in this EVM pass and is not closed route-negative.",
      "Institutional factory payment scans are capped if payment IDs exceed the configured read-only limit; account/role IDs are not persisted.",
      "Edge pool and PDN log coverage is bounded by RPC range/chunk behavior; missing logs are coverage caveats, not route-negative proof for unscanned ranges.",
      "No public borrower/account-health or liquidation endpoint was resolved for institutional or Edge pools.",
      "csUSD/csLYD vault balances and pool-token rows did not map to exact-positive trusted-consumer borrow, redemption, liquidation, or DEX unwind economics in this pass.",
      "No fork extraction proof and no signed action authorization.",
    ],
    requiredForRoutePositive: [
      "A specific cSigma pool/vault token must be accepted by a material trusted consumer or expose a permissionless accounting/redemption/borrow/liquidation path.",
      "Accepted value must diverge from acquisition/redemption/DEX reference value or a borrower/liquidation row must become exact-positive.",
      "The route must be permissionless and unblocked in current state with exact positive economics after gas, slippage, fees, and exit liquidity.",
      "Fork/static proof is required before any live or signed action.",
    ],
    nextReadOnlyStep: "Reopen cSigma only if a cSigma pool/vault token gains a material trusted consumer, a public borrower/liquidation endpoint appears, or accepted-value/redemption/DEX divergence maps to exact-positive economics; otherwise continue to Alpaca Finance 2.0.",
  };
  const addressRows = buildAddressRows(chainRows, institutionalRows, edgeRows, vaultRows, pdnRows);
  raw.localArtifactRows = findLocalArtifactJoins(addressRows);
  summarize(raw);
  writeJson(RAW_OUT, raw);
  writeReport(raw);
  if (!QUIET) {
    console.log(`cSigma Finance Phase 0: ${SIGNAL_DORMANT}`);
    console.log(`chainsScanned=${raw.summary.chainsScanned} edgePools=${raw.summary.edgePoolEvents} vaultRows=${raw.summary.vaultRows} watchCandidates=${raw.summary.watchCandidates} routePositive=${raw.summary.routePositive}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`cSigma Finance Phase 0 failed: ${err?.message || err}`);
  process.exit(1);
});
