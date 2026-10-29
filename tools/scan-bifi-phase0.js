#!/usr/bin/env node
// scan-bifi-phase0.js - bounded read-only Phase 0 for BiFi adapter pool contracts.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "bifi-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "bifi-phase0-triage.md");
const RAW_FAST = path.join(WORKSPACE, "reports", "raw", "fast");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "🟢 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const MATERIAL_USD = Number(process.env.BIFI_PHASE0_MATERIAL_USD || "10000");
const RECENT_BORROW_LOG_BLOCKS = Number(process.env.BIFI_PHASE0_RECENT_BORROW_LOG_BLOCKS || "50000");
const BORROW_LOG_CHUNK_BLOCKS = Number(process.env.BIFI_PHASE0_BORROW_LOG_CHUNK_BLOCKS || "5000");
const MAX_LOCAL_JOIN_FILES = Number(process.env.BIFI_PHASE0_MAX_LOCAL_JOIN_FILES || "350");

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = [
  { chain: "Ethereum", chainId: 1, adapterKey: "ethereum", dexChainId: "ethereum", coinSlug: "ethereum", nativeCoin: "coingecko:ethereum", nativeSymbol: "ETH" },
  { chain: "BNB Chain", chainId: 56, adapterKey: "bsc", dexChainId: "bsc", coinSlug: "bsc", nativeCoin: "coingecko:binancecoin", nativeSymbol: "BNB" },
  { chain: "Avalanche", chainId: 43114, adapterKey: "avax", dexChainId: "avalanche", coinSlug: "avax", nativeCoin: "coingecko:avalanche-2", nativeSymbol: "AVAX" },
];

const POOLS = [
  { chainId: 1, asset: "ETH", pool: "0x13000c4a215efe7e414bb329b2f11c39bcf92d78", token: NATIVE, decimals: 18, adapterKey: "null" },
  { chainId: 1, asset: "USDT", pool: "0x808c3ba97268dbf9695b1ec10729e09c7e67a9e3", token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  { chainId: 1, asset: "DAI", pool: "0xd76b7060f1b646fa14740ff6ac670a4f0a6fc5e3", token: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  { chainId: 1, asset: "LINK", pool: "0x25567603eb61a4a49f27e433652b5b8940d10682", token: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 },
  { chainId: 1, asset: "USDC", pool: "0x128647690C7733593aA3Dd149EeBC5e256E79217", token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  { chainId: 1, asset: "WBTC", pool: "0x93948Aa8488F522d5b079AF84fe411FBCE476e9f", token: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },

  { chainId: 56, asset: "BNB", pool: "0x170b6AA872166eC2F8515c2B855C34B6C7563c18", token: NATIVE, decimals: 18, adapterKey: "null" },
  { chainId: 56, asset: "USDT", pool: "0x2A29598cbc17BA112C8Fd0E07Fbf5402eF57E6b8", token: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  { chainId: 56, asset: "DAI", pool: "0xB67C5433d234d656002f12664d15ab4b40666D9B", token: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", decimals: 18 },
  { chainId: 56, asset: "ETH", pool: "0xf86d8218BCC15874f5D25c191FdDd43F2334c3EB", token: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", decimals: 18 },
  { chainId: 56, asset: "USDC", pool: "0xBA9De5a8FD91408826616f2d6d7470A11E34c9F0", token: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
  { chainId: 56, asset: "BTCB", pool: "0x26d0E4707af1c1DAAd8e9BA21b99cDa7Fd24c40B", token: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", decimals: 18 },
  { chainId: 56, asset: "BUSD", pool: "0x829ED2a2BeF8b72e648f92CBF01587C7E12e8c1e", token: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", decimals: 18 },

  { chainId: 43114, asset: "AVAX", pool: "0x446881360d6d39779D292662fca9BC85C5789dB3", token: NATIVE, decimals: 18, adapterKey: "null" },
  { chainId: 43114, asset: "WETH.e", pool: "0x8AbA88E8A4AB28319b782199cB17f0001EE67984", token: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", decimals: 18 },
  { chainId: 43114, asset: "USDT.e", pool: "0xE893233515b7D02dD4e3D888162d4C87Dc837943", token: "0xc7198437980c041c805A1EDcbA50c1Ce5db95118", decimals: 6 },
  { chainId: 43114, asset: "USDC.e", pool: "0x8385Ea36dD4BDC84B3F2ac718C332E18C1E42d36", token: "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664", decimals: 6 },
  { chainId: 43114, asset: "DAI.e", pool: "0x34DA42143b0c6E321CEb76931c637c12Bd865f7e", token: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", decimals: 18 },
  { chainId: 43114, asset: "WBTC.e", pool: "0xc4D1e935F02A44D44985E6b1C0eE1ee616fC146a", token: "0x50b7545627a5162F82A992c33b87aDc75187B218", decimals: 8 },
];

const OUT_OF_SCOPE_ADAPTER_ROWS = [
  { chain: "Klaytn", reason: "not in current RPC inventory/public Phase 0 queue for BiFi" },
  { chain: "Bifrost Network", reason: "not in current EVM RPC inventory/public Phase 0 queue for BiFi" },
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const GENERIC = new ethers.Interface([
  "function totalSupply() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalBorrow() view returns (uint256)",
  "function totalBorrowAmount() view returns (uint256)",
  "function totalDeposits() view returns (uint256)",
  "function totalDeposit() view returns (uint256)",
  "function getCash() view returns (uint256)",
  "function cash() view returns (uint256)",
  "function borrowCap() view returns (uint256)",
  "function supplyCap() view returns (uint256)",
  "function paused() view returns (bool)",
  "function isPaused() view returns (bool)",
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function oracle() view returns (address)",
  "function comptroller() view returns (address)",
]);
const BEACON = new ethers.Interface(["function implementation() view returns (address)"]);
const BORROW_UNINDEXED = new ethers.Interface(["event Borrow(address borrower,uint256 borrowAmount,uint256 accountBorrows,uint256 totalBorrows)"]);
const BORROW_INDEXED = new ethers.Interface(["event Borrow(address indexed borrower,uint256 borrowAmount,uint256 accountBorrows,uint256 totalBorrows)"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function safeText(value, max = 140) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function hexBlock(n) { return `0x${Number(n).toString(16)}`; }
function slotAddress(raw) { const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; return addr && addr !== ZERO ? addr : null; }
function sum(rows, field) { return rows.reduce((acc, row) => acc + (asNumber(row[field]) || 0), 0); }
function chainMeta(chainId) { return CHAINS.find((row) => row.chainId === Number(chainId)); }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-bifi-phase0/1.0" } });
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

async function getStorageAddress(rpc, address, slot) {
  const raw = await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null);
  return slotAddress(raw);
}

async function proxyMeta(rpc, address) {
  const [impl, admin, beacon] = await Promise.all([
    getStorageAddress(rpc, address, EIP1967_IMPL),
    getStorageAddress(rpc, address, EIP1967_ADMIN),
    getStorageAddress(rpc, address, EIP1967_BEACON),
  ]);
  const beaconImpl = beacon ? await safeCall(rpc, beacon, BEACON, "implementation") : null;
  return { eip1967Implementation: impl, eip1967Admin: admin, eip1967Beacon: beacon, eip1967BeaconImplementation: normalizeAddress(beaconImpl?.[0]) };
}

async function latestBlock(rpc) {
  const num = await rpcCall(rpc, "eth_blockNumber", [], 8_000).catch(() => null);
  const block = num ? await rpcCall(rpc, "eth_getBlockByNumber", [num, false], 8_000).catch(() => null) : null;
  return { number: num ? Number(BigInt(num)) : null, timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null };
}

async function tokenMeta(rpc, row) {
  if (row.token === NATIVE) return { symbol: row.asset, name: row.asset, decimals: row.decimals, address: NATIVE };
  const [symbol, name, decimals] = await Promise.all([
    safeCall(rpc, row.token, ERC20, "symbol"),
    safeCall(rpc, row.token, ERC20, "name"),
    safeCall(rpc, row.token, ERC20, "decimals"),
  ]);
  return {
    address: normalizeAddress(row.token),
    symbol: safeText(symbol?.[0], 40) || row.asset,
    name: safeText(name?.[0], 100),
    decimals: decimals?.[0] === undefined ? row.decimals : Number(decimals[0]),
  };
}

async function fetchPrices() {
  const ids = [];
  for (const row of POOLS) {
    const chain = chainMeta(row.chainId);
    if (!chain) continue;
    ids.push(row.token === NATIVE ? chain.nativeCoin : `${chain.coinSlug}:${normalizeAddress(row.token)}`);
  }
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${ids.slice(i, i + 50).join(",")}?searchWidth=6h`, 30_000) || { coins: {} };
    for (const [key, value] of Object.entries(json.coins || {})) out[key.toLowerCase()] = asNumber(value.price);
  }
  return out;
}

function priceFor(row, prices) {
  const chain = chainMeta(row.chainId);
  if (!chain) return null;
  const key = row.token === NATIVE ? chain.nativeCoin : `${chain.coinSlug}:${normalizeAddress(row.token)}`;
  return prices[String(key).toLowerCase()] ?? null;
}

async function nativeBalance(rpc, address) {
  const raw = await rpcCall(rpc, "eth_getBalance", [address, "latest"], 10_000).catch(() => null);
  return raw ? toBig(raw) : 0n;
}

async function tokenBalance(rpc, token, owner) {
  if (token === NATIVE) return nativeBalance(rpc, owner);
  const raw = await safeCall(rpc, token, ERC20, "balanceOf", [owner]);
  return raw?.[0] === undefined ? 0n : toBig(raw[0]);
}

async function probePool(rpc, pool, decimals) {
  const numericFns = ["totalSupply", "totalBorrows", "totalBorrow", "totalBorrowAmount", "totalDeposits", "totalDeposit", "getCash", "cash", "borrowCap", "supplyCap"];
  const boolFns = ["paused", "isPaused"];
  const addressFns = ["owner", "admin", "oracle", "comptroller"];
  const numeric = {};
  const bools = {};
  const addresses = {};
  for (const fn of numericFns) {
    const result = await safeCall(rpc, pool, GENERIC, fn);
    if (result?.[0] !== undefined) numeric[fn] = { raw: result[0].toString(), tokenUnits: round(unitsToNumber(result[0], decimals), 8) };
  }
  for (const fn of boolFns) {
    const result = await safeCall(rpc, pool, GENERIC, fn);
    if (result?.[0] !== undefined) bools[fn] = Boolean(result[0]);
  }
  for (const fn of addressFns) {
    const result = await safeCall(rpc, pool, GENERIC, fn);
    if (result?.[0]) addresses[fn] = normalizeAddress(result[0]);
  }
  return { numeric, bools, addresses };
}

async function getBorrowLogs(rpc, addresses, fromBlock, toBlock) {
  const logs = [];
  const errors = [];
  if (!addresses.length || fromBlock === null || fromBlock > toBlock) return { logs, errors };
  const topic0 = BORROW_UNINDEXED.getEvent("Borrow").topicHash;
  for (let from = fromBlock; from <= toBlock; from += BORROW_LOG_CHUNK_BLOCKS) {
    const to = Math.min(toBlock, from + BORROW_LOG_CHUNK_BLOCKS - 1);
    const chunk = await rpcCall(rpc, "eth_getLogs", [{ address: addresses, fromBlock: hexBlock(from), toBlock: hexBlock(to), topics: [topic0] }], 25_000).catch(() => null);
    if (Array.isArray(chunk)) logs.push(...chunk);
    else errors.push(`borrow-log-window-unavailable-${from}-${to}`);
  }
  return { logs, errors };
}

function decodeBorrower(log) {
  try { return normalizeAddress(BORROW_INDEXED.parseLog({ topics: log.topics, data: log.data })?.args?.borrower); } catch (_) {}
  try { return normalizeAddress(BORROW_UNINDEXED.parseLog({ topics: log.topics, data: log.data })?.args?.borrower); } catch (_) {}
  return null;
}

async function scanChain(rpc, chain, prices) {
  const latest = await latestBlock(rpc);
  const chainPools = POOLS.filter((row) => row.chainId === chain.chainId);
  const rows = [];
  for (const row of chainPools) {
    const pool = normalizeAddress(row.pool);
    const [code, meta, proxy, balanceRaw, probe] = await Promise.all([
      getCode(rpc, pool),
      tokenMeta(rpc, row),
      proxyMeta(rpc, pool),
      tokenBalance(rpc, row.token, pool),
      probePool(rpc, pool, row.decimals),
    ]);
    const decimals = meta.decimals ?? row.decimals;
    const priceUsd = priceFor(row, prices);
    const balance = unitsToNumber(balanceRaw, decimals);
    const balanceUsd = priceUsd === null || balance === null ? null : balance * priceUsd;
    const borrowLikeRaw = ["totalBorrows", "totalBorrow", "totalBorrowAmount"].map((fn) => probe.numeric[fn]?.tokenUnits).find((v) => asNumber(v) !== null && asNumber(v) > 0);
    const borrowLikeUsd = priceUsd === null || borrowLikeRaw === undefined ? null : asNumber(borrowLikeRaw) * priceUsd;
    rows.push({
      chain: chain.chain,
      chainId: chain.chainId,
      asset: row.asset,
      pool,
      token: row.token === NATIVE ? NATIVE : normalizeAddress(row.token),
      tokenSymbol: meta.symbol,
      tokenName: meta.name,
      decimals,
      poolCodePresent: Boolean(code && code !== "0x"),
      poolCodeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      ...proxy,
      priceUsd: round(priceUsd, 8),
      poolBalance: round(balance, 8),
      poolBalanceUsd: round(balanceUsd, 2),
      materialBalance: (asNumber(balanceUsd) || 0) >= MATERIAL_USD,
      borrowLikeUsd: round(borrowLikeUsd, 2),
      genericProbe: probe,
      pausedHint: Boolean(probe.bools.paused || probe.bools.isPaused),
      oracleHint: probe.addresses.oracle || null,
      comptrollerHint: probe.addresses.comptroller || null,
      blocker: "adapter pool balance context only; exact BiFi borrow/liquidation/account-health mechanics are not proven by this bounded pass",
    });
  }
  const fromBlock = latest.number === null ? null : Math.max(0, latest.number - RECENT_BORROW_LOG_BLOCKS);
  const logResult = await getBorrowLogs(rpc, rows.map((row) => row.pool), fromBlock, latest.number);
  const uniqueBorrowers = new Set(logResult.logs.map(decodeBorrower).filter(Boolean));
  return { chain: chain.chain, chainId: chain.chainId, rpcResolved: true, blockNumber: latest.number, blockTimestamp: latest.timestamp, poolRows: rows, borrowLogRows: logResult.logs.length, uniqueBorrowersSeen: uniqueBorrowers.size, borrowLogErrors: logResult.errors };
}

async function fetchMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/bifi", 45_000) || {};
  const latest = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1]?.totalLiquidityUSD : null;
  return {
    name: json.name || "BiFi",
    slug: json.slug || "bifi",
    category: json.category || "Lending",
    chains: json.chains || ["Ethereum", "Binance", "Avalanche"],
    module: json.module || "bifi/index.js",
    tvlCodePath: json.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/bifi/index.js",
    methodology: json.methodology || null,
    currentTvlUsd: round(latest ?? Object.values(json.currentChainTvls || {}).reduce((acc, value) => acc + (asNumber(value) || 0), 0), 2),
    ethereumTvlUsd: round(json.currentChainTvls?.Ethereum, 2),
    bnbTvlUsd: round(json.currentChainTvls?.Binance ?? json.currentChainTvls?.BSC, 2),
    avalancheTvlUsd: round(json.currentChainTvls?.Avalanche, 2),
  };
}

function collectLocalPoolJoins(poolRows) {
  const wanted = new Map(poolRows.map((row) => [lowerAddress(row.pool), row]));
  const rows = [];
  if (!fs.existsSync(RAW_FAST)) return rows;
  const files = fs.readdirSync(RAW_FAST).filter((file) => file.endsWith(".json") && file !== "bifi-phase0.json").slice(0, MAX_LOCAL_JOIN_FILES);
  for (const file of files) {
    const text = readText(path.join(RAW_FAST, file));
    if (!text) continue;
    for (const [addr, pool] of wanted.entries()) {
      if (text.toLowerCase().includes(addr)) rows.push({ sourceArtifact: `reports/raw/fast/${file}`, chain: pool.chain, asset: pool.asset, pool: pool.pool, side: "pool-address-exact-match" });
    }
  }
  return rows;
}

function writeReport(out) {
  const s = out.summary;
  const chainTable = out.chainResults.map((row) => `| ${row.chain} | ${row.rpcResolved} | ${row.blockNumber ?? "n/a"} | ${row.poolRows.length} | ${row.borrowLogRows} | ${row.uniqueBorrowersSeen} |`).join("\n");
  const poolTable = out.poolRows.map((row) => `| ${row.chain} | ${row.asset} | ${row.pool.slice(0, 6)}...${row.pool.slice(-4)} | ${row.poolCodePresent} | ${formatUsd(row.poolBalanceUsd)} | ${formatUsd(row.borrowLikeUsd)} | ${row.pausedHint} | ${row.oracleHint ? row.oracleHint.slice(0, 6) + "..." + row.oracleHint.slice(-4) : "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const joinTable = out.localPoolJoinRows.slice(0, 10).map((row) => `| ${row.sourceArtifact} | ${row.chain} | ${row.asset} | ${row.side} |`).join("\n") || "| none | n/a | n/a | n/a |";
  const content = `# ${SIGNAL_DORMANT} — BiFi Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-bifi-phase0.js\`

Artifact: \`reports/raw/fast/bifi-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This bounded pass follows the public DeFiLlama \`bifi/index.js\` adapter shape: per-asset pool/owner contracts on Ethereum, BNB Chain, and Avalanche. It checks live code, pool token balances, generic pool/lending method hints, recent borrow-like logs, and exact local pool-address joins. It does not prove a BiFi-specific borrow/liquidation/account-health route because the adapter is balance-owner based and no exact account-health, oracle divergence, liquidation, borrow, or unwind path was resolved.

## Summary

| Metric | Value |
|---|---:|
| DeFiLlama TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum TVL | ${formatUsd(s.ethereumTvlUsd)} |
| BNB TVL | ${formatUsd(s.bnbTvlUsd)} |
| Avalanche TVL | ${formatUsd(s.avalancheTvlUsd)} |
| Chains with RPC | \`${s.chainsWithRpc}\` |
| Pool rows | \`${s.poolRows}\` |
| Pools with code | \`${s.poolsWithCode}\` |
| Material balance rows | \`${s.materialBalanceRows}\` |
| Tracked pool balance | ${formatUsd(s.trackedPoolBalanceUsd)} |
| Borrow-like rows | \`${s.borrowLikeRows}\` |
| Recent borrow-log rows | \`${s.borrowLogRows}\` |
| Unique recent borrowers seen | \`${s.uniqueBorrowersSeen}\` |
| Exact local pool joins | \`${s.localPoolJoinRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |

## Chain Scan

| Chain | RPC resolved | Block | Pools | Borrow logs | Unique borrowers seen |
|---|---:|---:|---:|---:|---:|
${chainTable}

## Adapter Pools

| Chain | Asset | Pool | Code | Pool balance USD | Borrow-like USD | Paused hint | Oracle hint |
|---|---|---|---:|---:|---:|---:|---|
${poolTable}

## Exact Local Pool Joins

| Source artifact | Chain | Asset | Side |
|---|---|---|---|
${joinTable}

## Scope Caveats

- Klaytn and Bifrost Network adapter rows are recorded as unsupported/out-of-scope for this EVM RPC pass.
- Common underlying token appearances are not counted as BiFi-specific impact; only exact pool-address joins are counted.
- Generic pool method hits are hints only until mapped to verified BiFi source, account-health, liquidation, and exit economics.

## Blockers

- The public adapter exposes pool token balances, not a comptroller/market registry with decoded borrow and liquidation semantics.
- No BiFi-specific oracle, account-health, liquidation, or borrow path was decoded with exact positive economics.
- Recent borrow logs, if present, are context only without health/liquidation profitability and exit quotes.
- No exact local artifact joins to BiFi pool addresses mapped to trusted consumer economics.
- No fork extraction proof and no signed-action justification exist.

## Required For Route-Positive

- A BiFi market/account-health source must identify a currently borrowable or liquidatable path with material liquidity.
- Oracle/accepted-value divergence, stale feed acceptance, cap/pause drift, or liquidation discount must be proven against live state.
- Borrowed or seized assets must have exact positive unwind economics after gas, fees, and slippage.
- Fork extraction proof must show measured profit.

## Next Read-Only Step

Reopen BiFi only if verified source/ABI or a live account-health endpoint maps these pools to material borrow/liquidation economics; otherwise continue to the next public Phase 0 target.
`;
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const chainIds = CHAINS.map((row) => row.chainId);
  const [rpcPool, metadata, prices] = await Promise.all([resolveRpcPool(chainIds), fetchMetadata(), fetchPrices()]);
  const chainResults = [];
  for (const chain of CHAINS) {
    const rpc = rpcPool[chain.chainId];
    if (!rpc) {
      chainResults.push({ chain: chain.chain, chainId: chain.chainId, rpcResolved: false, poolRows: [], borrowLogRows: 0, uniqueBorrowersSeen: 0, borrowLogErrors: ["missing-rpc"] });
      continue;
    }
    if (!QUIET) console.log(`Scanning ${chain.chain}: pools=${POOLS.filter((row) => row.chainId === chain.chainId).length}`);
    chainResults.push(await scanChain(rpc, chain, prices));
  }
  const poolRows = chainResults.flatMap((row) => row.poolRows || []);
  const localPoolJoinRows = collectLocalPoolJoins(poolRows);
  const borrowLikeRows = poolRows.filter((row) => (asNumber(row.borrowLikeUsd) || 0) >= MATERIAL_USD);
  const watchCandidates = 0;
  const routePositive = 0;
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bifi-phase0.js",
    scope: "BiFi public Phase 0 adapter-pool, generic lending hints, borrow-log, and exact local pool-join triage",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, signedActionJustified: false },
    metadata: { ...metadata, adapterPools: POOLS, outOfScopeAdapterRows: OUT_OF_SCOPE_ADAPTER_ROWS },
    thresholds: { materialUsd: MATERIAL_USD, recentBorrowLogBlocks: RECENT_BORROW_LOG_BLOCKS, borrowLogChunkBlocks: BORROW_LOG_CHUNK_BLOCKS },
    chainResults,
    poolRows,
    localPoolJoinRows,
    blockers: ["BiFi adapter is pool-balance based and does not expose decoded account-health/liquidation semantics", "No BiFi-specific oracle divergence, borrow path, liquidation path, or exact positive unwind route was proven", "No exact local pool-address consumer join maps to extractive economics", "No fork extraction proof"],
    requiredForRoutePositive: ["verified BiFi market/account-health source", "permissionless borrow/liquidation trigger with material liquidity", "exact positive borrow/liquidation and unwind economics after costs", "fork extraction proof"],
    summary: {
      defillamaCurrentTvlUsd: metadata.currentTvlUsd,
      ethereumTvlUsd: metadata.ethereumTvlUsd,
      bnbTvlUsd: metadata.bnbTvlUsd,
      avalancheTvlUsd: metadata.avalancheTvlUsd,
      chainsWithRpc: chainResults.filter((row) => row.rpcResolved).length,
      chainsMissingRpc: chainResults.filter((row) => !row.rpcResolved).map((row) => row.chain),
      poolRows: poolRows.length,
      poolsWithCode: poolRows.filter((row) => row.poolCodePresent).length,
      materialBalanceRows: poolRows.filter((row) => row.materialBalance).length,
      trackedPoolBalanceUsd: round(sum(poolRows, "poolBalanceUsd"), 2),
      borrowLikeRows: borrowLikeRows.length,
      borrowLikeUsd: round(sum(borrowLikeRows, "borrowLikeUsd"), 2),
      borrowLogRows: chainResults.reduce((acc, row) => acc + (row.borrowLogRows || 0), 0),
      uniqueBorrowersSeen: chainResults.reduce((acc, row) => acc + (row.uniqueBorrowersSeen || 0), 0),
      localPoolJoinRows: localPoolJoinRows.length,
      watchCandidates,
      routePositive,
      executableNow: false,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      status: "bifi-phase0-no-route-positive",
    },
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  writeReport(out);
  if (!QUIET) {
    console.log(`BiFi Phase0: tvl=${formatUsd(out.summary.defillamaCurrentTvlUsd)} pools=${out.summary.poolRows} material=${out.summary.materialBalanceRows} borrowLogs=${out.summary.borrowLogRows} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => { console.error(String(err?.message || err).slice(0, 1000)); process.exit(1); });
