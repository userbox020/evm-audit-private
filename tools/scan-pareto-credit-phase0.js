#!/usr/bin/env node
// scan-pareto-credit-phase0.js - read-only Phase 0 for Pareto Credit credit-vault/tranche accounting and consumer joins.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "pareto-credit-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "pareto-credit-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const CREDIT_VAULT_DEPLOYED_TOPIC = "0x22d236b886e994153ab139e04b213355a725846284c6018c26c6af0988bd58d7";
const FACTORY_LOG_CHUNK_BLOCKS = Number(process.env.PARETO_FACTORY_LOG_CHUNK_BLOCKS || "100000");
const MAX_FACTORY_LOG_CHUNKS = Number(process.env.PARETO_MAX_FACTORY_LOG_CHUNKS || "80");

const CHAINS = {
  ethereum: { chainId: 1, chain: "Ethereum", coinSlug: "ethereum" },
  polygon: { chainId: 137, chain: "Polygon", coinSlug: "polygon" },
  arbitrum: { chainId: 42161, chain: "Arbitrum", coinSlug: "arbitrum" },
  optimism: { chainId: 10, chain: "Optimism", coinSlug: "optimism" },
};

const CONTRACTS = {
  ethereum: {
    usp: "0x97cCC1C046d067ab945d3CF3CC6920D3b1E54c88",
    factory: { block: 22938055, address: "0x59aabdad8fdabd227cc71543b128765f93906626" },
    credits: [
      { address: "0xf6223C567F21E33e859ED7A045773526E9E3c2D5", label: "Fasanara Yield vault" },
      { address: "0x4462eD748B8F7985A4aC6b538Dfc105Fce2dD165", label: "Bastion" },
      { address: "0x14B8E918848349D1e71e806a52c13D4e0d3246E0", label: "Adaptive Frontier" },
      { address: "0x433D5B175148dA32Ffe1e1A37a939E1b7e79be4d", label: "FalconX" },
    ],
  },
  polygon: { credits: [{ address: "0xF9E2AE779a7d25cDe46FccC41a27B8A4381d4e52", label: "Bastion CV" }] },
  optimism: {
    credits: [{ address: "0xD2c0D848aA5AD1a4C12bE89e713E70B73211989B", label: "FalconX" }],
    excludeVaultsAfterTimestamp: { "0xd2c0d848aa5ad1a4c12be89e713e70b73211989b": 1756936799 },
  },
  arbitrum: { credits: [{ address: "0x3919396Cd445b03E6Bb62995A7a4CB2AC544245D", label: "Bastion Credit Vault" }] },
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
const CREDIT = new ethers.Interface([
  "function token() view returns (address)",
  "function AATranche() view returns (address)",
  "function BBTranche() view returns (address)",
  "function priceAA() view returns (uint256)",
  "function priceBB() view returns (uint256)",
  "function strategy() view returns (address)",
  "function getContractValue() view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
]);
const STRATEGY = new ethers.Interface([
  "function pendingWithdraws() view returns (uint256)",
  "function pendingInstantWithdraws() view returns (uint256)",
  "function owner() view returns (address)",
]);
const USP = new ethers.Interface([
  "function queue() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const QUEUE = new ethers.Interface([
  "function getAllYieldSources() view returns (tuple(address token,address source,address vaultToken,uint256 maxCap,tuple(bytes4 method,uint8 methodType)[] allowedMethods,uint8 vaultType)[] yieldSources)",
  "function getCollateralsYieldSourceScaled(address) view returns (uint256)",
]);

const CONSUMER_ARTIFACTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["seven-chain-lending", "reports/raw/fast/seven-chain-lending-coverage.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-synthetic-consumer", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["layerzero-oft-dvn", "reports/raw/fast/layerzero-oft-dvn-consumer-joins.json"],
];
const DIRECT_ROLES = new Set(["paretoCreditVault", "paretoTrancheAA", "paretoTrancheBB", "paretoUSP", "paretoQueue", "paretoStrategy", "paretoVaultToken"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function safeText(value, max = 160) { return String(value || "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 2) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unitsToNumber(value, decimals = 18) { try { return Number(ethers.formatUnits(toBig(value), decimals)); } catch (_) { return null; } }
function slotAddress(raw) { const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; return addr && addr !== ZERO ? addr : null; }
function priceKey(chain, address) { return `${chain.coinSlug}:${String(address || "").toLowerCase()}`; }
function stableUsdGuess(symbol) { return /^(USDC|USDT|USDT0|DAI|USDS|USDE|USD\+?)$/i.test(String(symbol || "")) ? 1 : null; }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-pareto-phase0/1.0" } });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { ok: res.ok, status: res.status, json, error: res.ok ? null : safeText(text || `HTTP ${res.status}`, 120) };
  } catch (err) { return { ok: false, status: null, json: null, error: safeText(err?.name || err?.message || "transport-error", 80) }; }
  finally { clearTimeout(timer); }
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

async function getSlotAddress(rpc, address, slot) {
  const raw = await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null);
  return slotAddress(raw);
}

async function latestBlock(rpc) {
  const num = await rpcCall(rpc, "eth_blockNumber", [], 8_000).catch(() => null);
  const block = num ? await rpcCall(rpc, "eth_getBlockByNumber", [num, false], 8_000).catch(() => null) : null;
  return { number: num ? Number(BigInt(num)) : null, timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null };
}

async function tokenMeta(rpc, address, fallbackSymbol = null) {
  const addr = normalizeAddress(address);
  const [decimals, symbol, name, totalSupply, code] = await Promise.all([
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
    getCode(rpc, addr),
  ]);
  return {
    address: addr,
    symbol: safeText(symbol?.[0], 48) || fallbackSymbol,
    name: safeText(name?.[0], 96),
    decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    totalSupplyRaw: totalSupply?.[0]?.toString?.() || null,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
  };
}

function protocolMetadata() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.protocolCandidates || []), ...(d.consumerJoinFirst || [])];
  const row = rows.find((p) => p?.slug === "pareto-credit" || p?.name === "Pareto Credit");
  return row ? { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], evmChains: row.evmChains || [], tvlUsd: row.tvlUsd, change1dPct: row.change1dPct, change7dPct: row.change7dPct, routePriority: row.routePriority || null, source: "public-audit-target-discovery" } : { name: "Pareto Credit", slug: "pareto-credit", category: "RWA Lending", tvlUsd: null };
}

async function fetchPrices(tokenRows) {
  const keys = unique(tokenRows.map((row) => row.chain?.coinSlug && row.address ? priceKey(row.chain, row.address) : null).filter(Boolean));
  if (!keys.length) return { prices: new Map(), fetched: { ok: false, status: null, count: 0, error: "no-token-keys" } };
  const fetched = await fetchJson(`https://coins.llama.fi/prices/current/${keys.join(",")}?searchWidth=6h`, 30_000);
  const prices = new Map();
  for (const [key, row] of Object.entries(fetched.json?.coins || {})) {
    const price = Number(row?.price || 0);
    if (price > 0) prices.set(key.toLowerCase(), price);
  }
  return { prices, fetched: { ok: fetched.ok, status: fetched.status, count: prices.size, error: fetched.error } };
}

function decodeLogProxy(log) {
  const topics = log.topics || [];
  if (topics[1]) return normalizeAddress(`0x${topics[1].slice(26)}`);
  const data = strip0x(log.data || "");
  if (data.length >= 64) return normalizeAddress(`0x${data.slice(24, 64)}`);
  return null;
}

async function discoverFactoryCredits(rpc, chain, factory) {
  if (!factory?.address || !factory?.block) return { credits: [], errors: [], chunks: 0 };
  const latest = await latestBlock(rpc);
  if (!latest.number) return { credits: [], errors: [{ chain: chain.chain, reason: "latest-block-unavailable" }], chunks: 0 };
  const credits = [];
  const errors = [];
  let chunks = 0;
  for (let start = factory.block; start <= latest.number && chunks < MAX_FACTORY_LOG_CHUNKS; start += FACTORY_LOG_CHUNK_BLOCKS + 1) {
    const end = Math.min(latest.number, start + FACTORY_LOG_CHUNK_BLOCKS);
    const logs = await rpcCall(rpc, "eth_getLogs", [{ address: normalizeAddress(factory.address), topics: [CREDIT_VAULT_DEPLOYED_TOPIC], fromBlock: hexBlock(start), toBlock: hexBlock(end) }], 18_000).catch(() => null);
    chunks++;
    if (!Array.isArray(logs)) { errors.push({ chain: chain.chain, fromBlock: start, toBlock: end, reason: "eth_getLogs returned no usable rows" }); continue; }
    for (const log of logs) {
      const proxy = decodeLogProxy(log);
      if (proxy) credits.push({ address: proxy, label: "Factory credit vault", source: "factory-log", blockNumber: log.blockNumber ? Number(BigInt(log.blockNumber)) : null, txHash: log.transactionHash || null });
    }
  }
  if (chunks >= MAX_FACTORY_LOG_CHUNKS && factory.block + (chunks * (FACTORY_LOG_CHUNK_BLOCKS + 1)) <= latest.number) errors.push({ chain: chain.chain, reason: "factory-log-scan-capped", chunks });
  return { credits, errors, chunks };
}

function staticCreditsFor(chainKey, blockTimestamp) {
  const cfg = CONTRACTS[chainKey] || {};
  return (cfg.credits || []).map((row) => {
    const addr = normalizeAddress(row.address);
    const excludeAfter = cfg.excludeVaultsAfterTimestamp?.[lowerAddress(addr)];
    return { address: addr, label: row.label || "Static credit vault", source: "adapter-static", excludeAfterTimestamp: excludeAfter || null, excludedByAdapterTimestamp: Boolean(excludeAfter && blockTimestamp && Number(excludeAfter) <= Number(blockTimestamp)) };
  });
}

function mergeCreditInputs(...lists) {
  const by = new Map();
  for (const item of lists.flat()) {
    const addr = normalizeAddress(item.address);
    if (!addr) continue;
    const key = addr.toLowerCase();
    const prior = by.get(key) || {};
    by.set(key, { ...prior, ...item, address: addr, sources: unique([...(prior.sources || []), item.source]) });
  }
  return [...by.values()].sort((a, b) => a.address.localeCompare(b.address));
}

function liabilityRaw(totalSupplyRaw, priceRaw) {
  const total = toBig(totalSupplyRaw);
  const price = toBig(priceRaw);
  if (total <= 0n || price <= 0n) return 0n;
  return (total * price) / (10n ** 18n);
}

async function inspectCredit(rpc, chain, input) {
  const address = normalizeAddress(input.address);
  const code = await getCode(rpc, address);
  const [impl, admin, tokenAddr, aaAddr, bbAddr, priceAA, priceBB, strategyAddr, contractValue, paused, owner] = await Promise.all([
    getSlotAddress(rpc, address, EIP1967_IMPL),
    getSlotAddress(rpc, address, EIP1967_ADMIN),
    safeCall(rpc, address, CREDIT, "token"),
    safeCall(rpc, address, CREDIT, "AATranche"),
    safeCall(rpc, address, CREDIT, "BBTranche"),
    safeCall(rpc, address, CREDIT, "priceAA"),
    safeCall(rpc, address, CREDIT, "priceBB"),
    safeCall(rpc, address, CREDIT, "strategy"),
    safeCall(rpc, address, CREDIT, "getContractValue"),
    safeCall(rpc, address, CREDIT, "paused"),
    safeCall(rpc, address, CREDIT, "owner"),
  ]);
  const token = await tokenMeta(rpc, tokenAddr?.[0]);
  const aa = await tokenMeta(rpc, aaAddr?.[0], "AA Tranche");
  const bb = await tokenMeta(rpc, bbAddr?.[0], "BB Tranche");
  const strategy = normalizeAddress(strategyAddr?.[0]);
  const [pendingWithdraws, pendingInstantWithdraws, strategyOwner, creditTokenBalance, strategyTokenBalance] = await Promise.all([
    safeCall(rpc, strategy, STRATEGY, "pendingWithdraws"),
    safeCall(rpc, strategy, STRATEGY, "pendingInstantWithdraws"),
    safeCall(rpc, strategy, STRATEGY, "owner"),
    safeCall(rpc, token.address, ERC20, "balanceOf", [address]),
    safeCall(rpc, token.address, ERC20, "balanceOf", [strategy]),
  ]);
  const contractValueRaw = contractValue?.[0]?.toString?.() || "0";
  const pendingWithdrawsRaw = pendingWithdraws?.[0]?.toString?.() || "0";
  const pendingInstantWithdrawsRaw = pendingInstantWithdraws?.[0]?.toString?.() || "0";
  const trackedRaw = (toBig(contractValueRaw) + toBig(pendingWithdrawsRaw) + toBig(pendingInstantWithdrawsRaw)).toString();
  const aaLiabilityRaw = liabilityRaw(aa.totalSupplyRaw, priceAA?.[0]?.toString?.()).toString();
  const bbLiabilityRaw = liabilityRaw(bb.totalSupplyRaw, priceBB?.[0]?.toString?.()).toString();
  const totalTrancheLiabilityRaw = (toBig(aaLiabilityRaw) + toBig(bbLiabilityRaw)).toString();
  return {
    chainId: chain.chainId,
    chain: chain.chain,
    adapterChain: Object.keys(CHAINS).find((k) => CHAINS[k].chainId === chain.chainId),
    creditVault: address,
    label: input.label,
    sources: input.sources || [input.source].filter(Boolean),
    excludedByAdapterTimestamp: Boolean(input.excludedByAdapterTimestamp),
    excludeAfterTimestamp: input.excludeAfterTimestamp || null,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    implementation: impl,
    proxyAdmin: admin,
    owner: normalizeAddress(owner?.[0]),
    paused: paused?.[0] === undefined ? null : Boolean(paused[0]),
    token: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    strategy,
    strategyOwner: normalizeAddress(strategyOwner?.[0]),
    aaTranche: aa.address,
    aaSymbol: aa.symbol,
    aaTotalSupplyRaw: aa.totalSupplyRaw,
    priceAARaw: priceAA?.[0]?.toString?.() || null,
    aaLiabilityRaw,
    bbTranche: bb.address,
    bbSymbol: bb.symbol,
    bbTotalSupplyRaw: bb.totalSupplyRaw,
    priceBBRaw: priceBB?.[0]?.toString?.() || null,
    bbLiabilityRaw,
    totalTrancheLiabilityRaw,
    contractValueRaw,
    pendingWithdrawsRaw,
    pendingInstantWithdrawsRaw,
    trackedRaw,
    creditTokenBalanceRaw: creditTokenBalance?.[0]?.toString?.() || "0",
    strategyTokenBalanceRaw: strategyTokenBalance?.[0]?.toString?.() || "0",
    routePositive: false,
  };
}

async function inspectUsp(rpc, chain, creditRows) {
  const usp = normalizeAddress(CONTRACTS.ethereum.usp);
  const code = await getCode(rpc, usp);
  const [queue, totalSupply, decimals, symbol] = await Promise.all([
    safeCall(rpc, usp, USP, "queue"),
    safeCall(rpc, usp, USP, "totalSupply"),
    safeCall(rpc, usp, USP, "decimals"),
    safeCall(rpc, usp, USP, "symbol"),
  ]);
  const queueAddress = normalizeAddress(queue?.[0]);
  const [queueCode, yieldSources] = await Promise.all([
    getCode(rpc, queueAddress),
    safeCall(rpc, queueAddress, QUEUE, "getAllYieldSources", [], 20_000),
  ]);
  const sourceSet = new Set(creditRows.filter((row) => row.chain === "Ethereum" && !row.excludedByAdapterTimestamp).map((row) => lowerAddress(row.creditVault)));
  const yieldRows = [];
  let excludedScaled = 0n;
  for (const y of (yieldSources?.[0] || [])) {
    const source = normalizeAddress(y.source ?? y[1]);
    const token = normalizeAddress(y.token ?? y[0]);
    const vaultToken = normalizeAddress(y.vaultToken ?? y[2]);
    const isCredit = sourceSet.has(lowerAddress(source));
    let scaledRaw = "0";
    if (isCredit) {
      const scaled = await safeCall(rpc, queueAddress, QUEUE, "getCollateralsYieldSourceScaled", [source]);
      scaledRaw = scaled?.[0]?.toString?.() || "0";
      excludedScaled += toBig(scaledRaw);
    }
    yieldRows.push({ chainId: chain.chainId, chain: chain.chain, token, source, vaultToken, maxCapRaw: (y.maxCap ?? y[3])?.toString?.() || null, vaultType: Number(y.vaultType ?? y[6] ?? 0), isConfiguredCreditVault: isCredit, collateralScaledRaw: scaledRaw, routePositive: false });
  }
  const totalRaw = totalSupply?.[0]?.toString?.() || "0";
  const uspTvlUsdcRaw = ((toBig(totalRaw) - excludedScaled) / (10n ** 12n)).toString();
  return {
    uspRow: {
      chainId: chain.chainId,
      chain: chain.chain,
      usp,
      symbol: safeText(symbol?.[0], 40) || "USP",
      decimals: decimals?.[0] === undefined ? 18 : Number(decimals[0]),
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      queue: queueAddress,
      queueCodePresent: Boolean(queueCode && queueCode !== "0x"),
      totalSupplyRaw: totalRaw,
      excludedCreditScaledRaw: excludedScaled.toString(),
      uspTvlUsdcRaw,
      routePositive: false,
    },
    yieldRows,
  };
}

function enrichRows(creditRows, uspRow, prices) {
  for (const row of creditRows) {
    const chain = CHAINS[row.adapterChain];
    const price = prices.get(priceKey(chain, row.token).toLowerCase()) || stableUsdGuess(row.tokenSymbol);
    row.tokenPriceUsd = price || null;
    row.contractValueAmount = round(unitsToNumber(row.contractValueRaw, row.tokenDecimals ?? 18), 8);
    row.pendingWithdrawsAmount = round(unitsToNumber(row.pendingWithdrawsRaw, row.tokenDecimals ?? 18), 8);
    row.pendingInstantWithdrawsAmount = round(unitsToNumber(row.pendingInstantWithdrawsRaw, row.tokenDecimals ?? 18), 8);
    row.trackedAmount = round(unitsToNumber(row.trackedRaw, row.tokenDecimals ?? 18), 8);
    row.trackedUsd = price ? round((row.trackedAmount || 0) * price, 2) : null;
    row.aaLiabilityAmount = round(unitsToNumber(row.aaLiabilityRaw, row.tokenDecimals ?? 18), 8);
    row.bbLiabilityAmount = round(unitsToNumber(row.bbLiabilityRaw, row.tokenDecimals ?? 18), 8);
    row.totalTrancheLiabilityAmount = round(unitsToNumber(row.totalTrancheLiabilityRaw, row.tokenDecimals ?? 18), 8);
    row.totalTrancheLiabilityUsd = price ? round((row.totalTrancheLiabilityAmount || 0) * price, 2) : null;
    row.liabilityMinusTrackedUsd = row.totalTrancheLiabilityUsd === null || row.trackedUsd === null ? null : round(row.totalTrancheLiabilityUsd - row.trackedUsd, 2);
    row.creditTokenBalanceAmount = round(unitsToNumber(row.creditTokenBalanceRaw, row.tokenDecimals ?? 18), 8);
    row.strategyTokenBalanceAmount = round(unitsToNumber(row.strategyTokenBalanceRaw, row.tokenDecimals ?? 18), 8);
    row.accountingContextOnly = true;
  }
  if (uspRow) {
    uspRow.uspTvlUsdcAmount = round(unitsToNumber(uspRow.uspTvlUsdcRaw, 6), 8);
    uspRow.uspTvlUsd = round(uspRow.uspTvlUsdcAmount || 0, 2);
  }
}

function primitiveAddresses(value, out = new Set()) {
  if (typeof value === "string") { for (const m of value.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0].toLowerCase()); }
  else if (Array.isArray(value)) { for (const item of value) primitiveAddresses(item, out); }
  else if (value && typeof value === "object") { for (const item of Object.values(value)) primitiveAddresses(item, out); }
  return out;
}

function summarizeContext(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "project", "name", "chain", "chainId", "surface", "side", "symbol", "asset", "token", "collateral", "borrowAsset", "loanAsset", "oracle", "source", "status", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "file", "rootFile"];
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
    out.push({ source, hitRoles: roles, hitAddresses: hits.slice(0, 12), chains: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.chain)).filter(Boolean)).slice(0, 8), directConsumer: roles.some((role) => DIRECT_ROLES.has(role)), context: summarizeContext(obj), routePositive: false, blocker: "Local artifact address match is context only unless Pareto vault/tranche/USP state is trusted by consumer logic with exact positive economics" });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(creditRows, uspRow, yieldRows) {
  const roles = {};
  function add(addr, role) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO.toLowerCase()) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push(role);
  }
  for (const row of creditRows) {
    add(row.creditVault, { role: "paretoCreditVault", chain: row.chain, label: row.label });
    add(row.aaTranche, { role: "paretoTrancheAA", chain: row.chain, label: row.label });
    add(row.bbTranche, { role: "paretoTrancheBB", chain: row.chain, label: row.label });
    add(row.strategy, { role: "paretoStrategy", chain: row.chain, label: row.label });
    add(row.token, { role: "underlyingToken", chain: row.chain, symbol: row.tokenSymbol });
  }
  if (uspRow) { add(uspRow.usp, { role: "paretoUSP", chain: uspRow.chain }); add(uspRow.queue, { role: "paretoQueue", chain: uspRow.chain }); }
  for (const row of yieldRows || []) add(row.vaultToken, { role: "paretoVaultToken", chain: row.chain });
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) {
    const json = readJson(path.join(WORKSPACE, rel), null);
    if (json) scanObjectForAddresses(source, json, roles, matches);
  }
  return { directConsumerRows: matches.filter((row) => row.directConsumer), tokenContextRows: matches.filter((row) => !row.directConsumer) };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const creditTable = artifact.creditRows.filter((row) => !row.excludedByAdapterTimestamp).slice(0, 18).map((row) => `| ${row.chain} | ${row.label || "Credit vault"} | ${compactAddress(row.creditVault)} | ${row.tokenSymbol || "n/a"} | ${formatUsd(row.trackedUsd)} | ${formatUsd(row.totalTrancheLiabilityUsd)} | ${row.paused === null ? "n/a" : row.paused ? "yes" : "no"} | ${compactAddress(row.aaTranche)} / ${compactAddress(row.bbTranche)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const uspTable = artifact.uspRow ? `| Ethereum | ${compactAddress(artifact.uspRow.usp)} | ${compactAddress(artifact.uspRow.queue)} | ${formatNumber(artifact.uspRow.uspTvlUsdcAmount, 2)} USDC | ${formatUsd(artifact.uspRow.uspTvlUsd)} | ${artifact.uspRow.queueCodePresent ? "yes" : "no"} |` : "| none | n/a | n/a | n/a | n/a | n/a |";
  const directConsumerTable = artifact.directConsumerRows.length ? artifact.directConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.chains.join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Pareto vault/tranche/USP address match was found in consumer-grade artifacts |";
  const factoryErrors = artifact.factoryLogErrors.length ? artifact.factoryLogErrors.map((row) => `| ${row.chain || "n/a"} | ${row.fromBlock || "n/a"} | ${row.toBlock || "n/a"} | ${row.reason} |`).join("\n") : "| none | n/a | n/a | n/a |";
  return `# ${SIGNAL_DORMANT} - Pareto Credit Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit for the covered Pareto Credit credit-vault/tranche accounting scope. The public adapter exposes USP and credit vault accounting, not a public pooled borrower market with account-level liquidations. The scan refreshed static adapter vaults, Ethereum factory-discovered vaults, tranche tokens, strategies, contract values, pending withdrawals, USP queue accounting, and local consumer joins. Pareto vault-token address matches were found only as aggregate-artifact context, not as a material consumer dependency with trusted NAV/redemption/accounting state. Underlying USDC/USDT-style joins remain common-token context only.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Adapter chains known | ${s.adapterChainsKnown} |
| Chains inspected | ${s.chainsInspected} |
| Static credit vaults | ${s.staticCreditVaults} |
| Factory-discovered credit vaults | ${s.factoryDiscoveredCreditVaults} |
| Credit vault rows | ${s.creditRows} |
| Active adapter credit vault rows | ${s.activeCreditRows} |
| Credit rows with code | ${s.creditRowsWithCode} |
| Tranche token rows | ${s.trancheRows} |
| Tracked credit value | ${formatUsd(s.trackedCreditUsd)} |
| USP TVL context | ${formatUsd(s.uspTvlUsd)} |
| Pareto address-match rows | ${s.directConsumerRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |
| Coverage classification | ${s.coverageClassification} |

## Active Credit Vaults

| Chain | Label | Credit vault | Token | Tracked value | Tranche liability context | Paused | Tranches |
|---|---|---|---|---:|---:|---|---|
${creditTable}

## USP Context

| Chain | USP | Queue | Adapter USDC TVL amount | USD | Queue code |
|---|---|---|---:|---:|---|
${uspTable}

## Pareto Address-Match Context

| Source | Hit roles | Addresses | Chains | Context |
|---|---|---|---|---|
${directConsumerTable}

## Factory Log Caveats

| Chain | From block | To block | Reason |
|---|---:|---:|---|
${factoryErrors}

## Blockers

- Adapter surface is credit-vault/tranche accounting, not an open pooled borrower liquidation market.
- Pareto address matches are context-only; no scanned consumer-grade artifact shows trusted Pareto NAV, redemption, queue, tranche, or accounting state with exact economics.
- Tranche liability versus tracked value is accounting context only without a permissionless redeem/borrow/liquidation route.
- Underlying-token joins are common USDC/USDT-style context and not Pareto-specific impact.
- No exact positive redemption, borrow, liquidation, settlement, bridge, or DEX unwind economics and no fork/local proof exist.

## Required For Route-Positive

- A deployed consumer references Pareto vault, tranche, USP, queue, NAV, redemption, or accounting state.
- A permissionless vault/tranche/redeem/accounting weakness affects liquid assets or accepted collateral value.
- Exact borrow, redeem, liquidate, bridge, or unwind economics are positive after costs.
- Fork/local proof demonstrates positive net value.

Artifacts: \`reports/raw/fast/pareto-credit-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const chainKeys = Object.keys(CHAINS);
  const rpcs = await resolveRpcPool(chainKeys.map((key) => CHAINS[key].chainId));
  const blocks = {};
  for (const key of chainKeys) blocks[key] = await latestBlock(rpcs[CHAINS[key].chainId]);
  const unsupportedChains = [];
  const factoryLogErrors = [];
  const factoryDiscoveredInputs = {};
  for (const key of chainKeys) {
    const rpc = rpcs[CHAINS[key].chainId];
    if (!rpc) { unsupportedChains.push({ chain: CHAINS[key].chain, reason: "no RPC resolved" }); continue; }
    if (CONTRACTS[key]?.factory) {
      const discovered = await discoverFactoryCredits(rpc, CHAINS[key], CONTRACTS[key].factory);
      factoryDiscoveredInputs[key] = discovered.credits;
      factoryLogErrors.push(...discovered.errors);
    }
  }
  const creditInputs = {};
  let staticCreditVaults = 0;
  for (const key of chainKeys) {
    const statics = staticCreditsFor(key, blocks[key]?.timestamp);
    staticCreditVaults += statics.length;
    creditInputs[key] = mergeCreditInputs(statics, factoryDiscoveredInputs[key] || []);
  }
  const creditRows = [];
  for (const key of chainKeys) {
    const rpc = rpcs[CHAINS[key].chainId];
    if (!rpc) continue;
    for (const input of creditInputs[key]) {
      try { creditRows.push(await inspectCredit(rpc, CHAINS[key], input)); }
      catch (err) { factoryLogErrors.push({ chain: CHAINS[key].chain, reason: safeText(`credit-scan-error ${input.address}: ${err?.message || err}`, 180) }); }
    }
  }
  const usp = rpcs[1] ? await inspectUsp(rpcs[1], CHAINS.ethereum, creditRows).catch((err) => ({ uspRow: null, yieldRows: [], error: safeText(err?.message || err) })) : { uspRow: null, yieldRows: [] };
  if (usp.error) factoryLogErrors.push({ chain: "Ethereum", reason: `usp-scan-error ${usp.error}` });
  const tokenRows = [];
  for (const row of creditRows) tokenRows.push({ chain: CHAINS[row.adapterChain], address: row.token, symbol: row.tokenSymbol });
  tokenRows.push({ chain: CHAINS.ethereum, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC" });
  const priceFetch = await fetchPrices(tokenRows);
  enrichRows(creditRows, usp.uspRow, priceFetch.prices);
  const joins = localConsumerJoins(creditRows, usp.uspRow, usp.yieldRows);
  const activeCreditRows = creditRows.filter((row) => !row.excludedByAdapterTimestamp);
  const directConsumerRows = joins.directConsumerRows;
  const tokenContextRows = joins.tokenContextRows;
  const summary = {
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    adapterChainsKnown: chainKeys.length,
    chainsInspected: chainKeys.filter((key) => Boolean(rpcs[CHAINS[key].chainId])).length,
    unsupportedChains: unsupportedChains.length,
    staticCreditVaults,
    factoryDiscoveredCreditVaults: Object.values(factoryDiscoveredInputs).reduce((sum, rows) => sum + (rows?.length || 0), 0),
    creditRows: creditRows.length,
    activeCreditRows: activeCreditRows.length,
    creditRowsWithCode: creditRows.filter((row) => row.codePresent).length,
    trancheRows: creditRows.reduce((sum, row) => sum + (row.aaTranche ? 1 : 0) + (row.bbTranche ? 1 : 0), 0),
    trackedCreditUsd: round(activeCreditRows.reduce((sum, row) => sum + (asNumber(row.trackedUsd) || 0), 0), 2),
    trancheLiabilityUsd: round(activeCreditRows.reduce((sum, row) => sum + (asNumber(row.totalTrancheLiabilityUsd) || 0), 0), 2),
    uspTvlUsd: usp.uspRow?.uspTvlUsd || 0,
    yieldSourceRows: usp.yieldRows?.length || 0,
    factoryLogErrors: factoryLogErrors.length,
    directConsumerRows: directConsumerRows.length,
    tokenContextRows: tokenContextRows.length,
    watchCandidates: directConsumerRows.length,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: unsupportedChains.length || factoryLogErrors.length ? "bounded-with-caveats" : "full-enough-for-declared-scope",
    closedReason: "credit-vault/tranche accounting surface has only context address matches and no Pareto-specific consumer route or exact positive economics",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-pareto-credit-phase0.js",
    scope: "Read-only Pareto Credit credit-vault/tranche accounting and consumer-route Phase 0 scan",
    target: { name: "Pareto Credit", slug: "pareto-credit", category: "RWA Lending", surface: "credit-vault-tranche-rwa", metadata },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    docs: { adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/pareto/index.js", tvlCodePath: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/pareto/index.js" },
    thresholds: { factoryLogChunkBlocks: FACTORY_LOG_CHUNK_BLOCKS, maxFactoryLogChunks: MAX_FACTORY_LOG_CHUNKS },
    priceFetch: priceFetch.fetched,
    unsupportedChains,
    factoryLogErrors,
    uspRow: usp.uspRow,
    yieldRows: usp.yieldRows || [],
    creditRows: creditRows.sort((a, b) => (asNumber(b.trackedUsd) || 0) - (asNumber(a.trackedUsd) || 0)),
    directConsumerRows,
    tokenContextRows: tokenContextRows.slice(0, 180),
    watchCandidates: directConsumerRows.map((row) => ({ ...row, routePositive: false })),
    routePositiveRows: [],
    summary,
    blockers: [
      "Adapter surface is credit-vault/tranche accounting, not an open pooled borrower liquidation market",
      "Pareto address matches are context-only; no scanned consumer-grade artifact shows trusted Pareto NAV, redemption, queue, tranche, or accounting state with exact economics",
      "Tranche liability versus tracked value is accounting context only without a permissionless redeem/borrow/liquidation route",
      "Underlying-token joins are common USDC/USDT-style context and not Pareto-specific impact",
      "No exact positive redemption, borrow, liquidation, settlement, bridge, or DEX unwind economics or proof",
    ],
    requiredForRoutePositive: [
      "deployed consumer references Pareto vault, tranche, USP, queue, NAV, redemption, or accounting state",
      "permissionless vault/tranche/redeem/accounting weakness affects liquid assets or accepted collateral value",
      "exact borrow, redeem, liquidate, bridge, or unwind economics are positive after costs",
      "fork/local proof",
    ],
    nextReadOnlyStep: "Reopen Pareto only if a Pareto-specific consumer appears, a permissionless tranche/redeem/accounting weakness is proven, or factory-discovered credit vault state maps to exact positive economics.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Pareto Credit Phase 0: creditRows=${summary.creditRows} active=${summary.activeCreditRows} factoryDiscovered=${summary.factoryDiscoveredCreditVaults} trackedCreditUsd=${summary.trackedCreditUsd} directConsumers=${summary.directConsumerRows} watch=${summary.watchCandidates} routePositive=0`);
}

main().catch((err) => { console.error(safeText(err?.message || String(err), 240)); process.exit(1); });
