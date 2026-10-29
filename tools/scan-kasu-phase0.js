#!/usr/bin/env node
// scan-kasu-phase0.js - bounded read-only Kasu Phase 0 scan on Base.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, calldata, borrower addresses, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "kasu-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "kasu-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const BASE_CHAIN_ID = 8453;
const ZERO = "0x0000000000000000000000000000000000000000";
const MATERIAL_USD = Number(process.env.KASU_PHASE0_MATERIAL_USD || "10000");
const MAX_DEX_TOKENS = Number(process.env.KASU_PHASE0_MAX_DEX_TOKENS || "30");
const MAX_LOCAL_ARTIFACT_BYTES = Number(process.env.KASU_PHASE0_MAX_LOCAL_ARTIFACT_BYTES || "2500000");

const KASU = {
  chain: "Base",
  chainId: BASE_CHAIN_ID,
  graphURL: "https://api.goldsky.com/api/public/project_cmgzlpxm300765np2a19421om/subgraphs/kasu-base/v1.0.13/gn",
  externalContract: "0x662379FEBb3e4F91400B5f7d4f7F7ce4699F3c9F",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  assetSymbol: "USDC",
};

const LOCAL_ARTIFACTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["seven-chain-lending", "reports/raw/fast/seven-chain-lending-coverage.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["evault-collateral-nav", "reports/raw/fast/evault-collateral-nav-manipulation.json"],
  ["focused-morpho", "reports/raw/fast/focused-morpho-review-producers.json"],
  ["focused-euler", "reports/raw/fast/focused-euler-evk-review-producers.json"],
  ["morpho-pyth", "reports/raw/fast/morpho-pyth-unsafe-consumers.json"],
  ["morpho-liquidatable", "reports/raw/fast/morpho-liquidatable-marketability.json"],
  ["morpho-wrapper-exit", "reports/raw/fast/morpho-wrapper-exit-proof-gaps.json"],
  ["current-liquidatable", "reports/raw/fast/current-liquidatable-exit-routes.json"],
  ["pendle-pt", "reports/raw/fast/pendle-pt-multichain-consumer-graph.json"],
  ["silo-pt", "reports/raw/fast/silo-pt-oracle-routes.json"],
  ["dex-consumer", "reports/raw/fast/dex-consumer-routes.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
];

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const BYTES32_META = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const COMMON = new ethers.Interface([
  "function asset() view returns (address)",
  "function underlying() view returns (address)",
  "function loanToken() view returns (address)",
  "function collateralToken() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalBorrowed() view returns (uint256)",
  "function totalDebt() view returns (uint256)",
  "function getCash() view returns (uint256)",
  "function cash() view returns (uint256)",
  "function borrowCap() view returns (uint256)",
  "function supplyCap() view returns (uint256)",
  "function paused() view returns (bool)",
  "function isPaused() view returns (bool)",
  "function isStopped() view returns (bool)",
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function manager() view returns (address)",
  "function oracle() view returns (address)",
  "function comptroller() view returns (address)",
]);
const EXTERNAL = new ethers.Interface(["function externalTVLOfPool(address) view returns (uint256)"]);

const SELECTOR_SIGS = {
  supplyRedeem: ["deposit(uint256,address)", "deposit(address,uint256)", "withdraw(uint256,address,address)", "withdraw(address,uint256)", "redeem(uint256,address,address)", "mint(uint256)"],
  borrowRepay: ["borrow(uint256)", "borrow(address,uint256)", "repay(uint256)", "repayBorrow(uint256)", "repay(address,uint256)"],
  liquidate: ["liquidate(address,uint256,address)", "liquidateBorrow(address,uint256,address)", "seize(address,address,uint256)"],
  admin: ["pause()", "unpause()", "setPaused(bool)", "setOracle(address)", "setBorrowCap(uint256)", "setSupplyCap(uint256)", "upgradeTo(address)"],
};

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const text = readText(file).replace(/^\uFEFF/, ""); return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, jsonReplacer, 2)}\n`); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function safeText(value, max = 160) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function formatNum(value, decimals = 4) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: decimals }); }
function decodeBytes32String(value) { try { return value && value !== "0x" ? safeText(ethers.decodeBytes32String(value), 80) : null; } catch (_) { return null; } }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-kasu-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function fetchText(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-kasu-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function gql(query, variables = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(KASU.graphURL, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "user-agent": "evm-audit-kasu-phase0/1.0" },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; ").slice(0, 500));
    return json.data || {};
  } finally {
    clearTimeout(timer);
  }
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

function protocolMetadata(apiRaw) {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.targetedRefreshQueue || []), ...(d.protocolCandidates || [])];
  const row = rows.find((p) => p?.slug === "kasu" || p?.name === "Kasu");
  const latestTvl = Array.isArray(apiRaw?.tvl) ? asNumber(apiRaw.tvl.at(-1)?.totalLiquidityUSD) : asNumber(apiRaw?.tvl);
  return {
    name: apiRaw?.name || row?.name || "Kasu",
    slug: apiRaw?.slug || row?.slug || "kasu",
    category: apiRaw?.category || row?.category || "RWA Lending",
    module: apiRaw?.module || "kasu/index.js",
    tvlCodePath: apiRaw?.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/kasu/index.js",
    methodology: safeText(apiRaw?.methodology || "Count all assets deposited to Kasu Lending Pools plus externally managed TVL", 260),
    chains: apiRaw?.chains || row?.chains || ["Base", "XDC", "Plume Mainnet"],
    evmChains: row?.evmChains || ["Base"],
    tvlUsd: round(latestTvl ?? row?.tvlUsd, 2),
    baseTvlUsd: round(apiRaw?.currentChainTvls?.Base ?? row?.tvlUsd, 2),
    change1dPct: row?.change1dPct ?? apiRaw?.change_1d ?? null,
    change7dPct: row?.change7dPct ?? apiRaw?.change_7d ?? null,
    audits: apiRaw?.audits ?? null,
    url: apiRaw?.url || null,
    twitter: apiRaw?.twitter || null,
    sourceAvailability: "defillama-adapter-and-live-bytecode; no canonical public Kasu source repo resolved in this pass",
  };
}

async function graphSchema() {
  const query = `{
    queryType: __schema { queryType { fields { name } } }
    lendingPool: __type(name: "LendingPool") { fields { name type { kind name ofType { kind name ofType { kind name } } } } }
  }`;
  const data = await gql(query, {}, 30_000).catch((err) => ({ error: safeText(err.message, 500) }));
  const queryFields = (data?.queryType?.queryType?.fields || []).map((f) => f.name).sort();
  const lendingPoolFields = (data?.lendingPool?.fields || []).map((f) => f.name).sort();
  return { queryFields, lendingPoolFields, error: data?.error || null };
}

function pickFields(available, candidates) {
  const set = new Set(available || []);
  return candidates.filter((field) => set.has(field));
}

async function graphPools(schema) {
  const desired = [
    "id", "name", "isStopped", "createdAt", "updatedAt", "poolType", "asset", "underlying", "loanToken", "collateralToken", "borrower", "lender", "owner", "manager",
    "balance", "configuration", "feesOwedAmount", "firstLostCapital", "losses", "totalDepositsAccepted", "totalFeesAmount", "totalLossAmount", "totalUserInterestAmount", "totalWithdrawalsAccepted", "userOwedAmount",
    "totalSupply", "totalAssets", "totalDeposited", "totalBorrowed", "totalBorrows", "borrowed", "deposited", "externalTvl", "externalTVL",
    "interestRate", "borrowRate", "supplyRate", "ltv", "lltv", "maturity", "duration",
  ];
  const fields = unique(["id", ...pickFields(schema.lendingPoolFields, desired)]);
  const query = `{ lendingPools(first: 1000, where: { isStopped: false }) { ${fields.join(" ")} } }`;
  const data = await gql(query, {}, 45_000).catch((err) => ({ error: safeText(err.message, 500), lendingPools: [] }));
  return { fields, rows: data?.lendingPools || [], error: data?.error || null };
}

async function graphLoanLikeRows(schema) {
  const queryFields = schema.queryFields || [];
  const candidates = queryFields.filter((name) => /(loan|borrow|position|account|repay|liquidat)/i.test(name) && !/^_/.test(name)).slice(0, 8);
  const rows = [];
  const errors = [];
  for (const name of candidates) {
    const singular = name.endsWith("s") ? name.slice(0, -1) : name;
    const typeName = singular.charAt(0).toUpperCase() + singular.slice(1);
    const typeData = await gql(`{ t: __type(name: "${typeName}") { fields { name } } }`).catch(() => null);
    const fields = pickFields((typeData?.t?.fields || []).map((f) => f.name), ["id", "pool", "lendingPool", "borrower", "account", "user", "asset", "collateral", "debt", "amount", "principal", "borrowed", "status", "health", "healthFactor"]);
    if (!fields.includes("id")) fields.unshift("id");
    if (fields.length <= 1) continue;
    const query = `{ ${name}(first: 25) { ${fields.join(" ")} } }`;
    const data = await gql(query, {}, 20_000).catch((err) => ({ error: err.message }));
    if (data?.error) errors.push({ collection: name, error: safeText(data.error, 240) });
    const collectionRows = Array.isArray(data?.[name]) ? data[name] : [];
    rows.push({ collection: name, fields, rows: collectionRows.slice(0, 25) });
  }
  return { collectionsTried: candidates, rows, errors };
}

async function tokenMeta(rpc, token, fallback = {}) {
  const addr = normalizeAddress(token);
  if (!addr) return { address: null, symbol: fallback.symbol || null, name: fallback.name || null, decimals: fallback.decimals ?? 18, codeBytes: 0 };
  const [code, sym, symB32, name, nameB32, dec, supply] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, BYTES32_META, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, BYTES32_META, "name"),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
  ]);
  const decimals = dec ? Number(dec[0]) : Number(fallback.decimals ?? 18);
  return {
    address: addr,
    codePresent: code !== "0x",
    codeBytes: Math.max(0, (code.length - 2) / 2),
    symbol: safeText(sym?.[0] || decodeBytes32String(symB32?.[0]) || fallback.symbol || "UNK", 32),
    name: safeText(name?.[0] || decodeBytes32String(nameB32?.[0]) || fallback.name || "", 100),
    decimals,
    totalSupplyRaw: supply ? supply[0].toString() : null,
    totalSupply: supply ? unitsToNumber(supply[0], decimals) : null,
  };
}

function selectorHints(code) {
  const hex = strip0x(code).toLowerCase();
  const out = {};
  for (const [group, sigs] of Object.entries(SELECTOR_SIGS)) {
    const hits = sigs.filter((sig) => hex.includes(ethers.id(sig).slice(2, 10).toLowerCase()));
    if (hits.length) out[group] = hits;
  }
  return out;
}

async function poolRow(rpc, graphRow, assetMeta, externalCode) {
  const address = normalizeAddress(graphRow.id);
  const code = await getCode(rpc, address);
  const meta = await tokenMeta(rpc, address, { symbol: "kasuPool", decimals: assetMeta.decimals });
  const [impl, ext, asset, underlying, loanToken, collateralToken, totalAssets, totalBorrows, totalBorrowed, totalDebt, getCash, cash, borrowCap, supplyCap, paused, isPaused, isStopped, owner, admin, manager, oracle, comptroller] = await Promise.all([
    getImpl(rpc, address, 10_000).catch(() => null),
    externalCode !== "0x" ? safeCall(rpc, KASU.externalContract, EXTERNAL, "externalTVLOfPool", [address], 10_000) : null,
    safeCall(rpc, address, COMMON, "asset"),
    safeCall(rpc, address, COMMON, "underlying"),
    safeCall(rpc, address, COMMON, "loanToken"),
    safeCall(rpc, address, COMMON, "collateralToken"),
    safeCall(rpc, address, COMMON, "totalAssets"),
    safeCall(rpc, address, COMMON, "totalBorrows"),
    safeCall(rpc, address, COMMON, "totalBorrowed"),
    safeCall(rpc, address, COMMON, "totalDebt"),
    safeCall(rpc, address, COMMON, "getCash"),
    safeCall(rpc, address, COMMON, "cash"),
    safeCall(rpc, address, COMMON, "borrowCap"),
    safeCall(rpc, address, COMMON, "supplyCap"),
    safeCall(rpc, address, COMMON, "paused"),
    safeCall(rpc, address, COMMON, "isPaused"),
    safeCall(rpc, address, COMMON, "isStopped"),
    safeCall(rpc, address, COMMON, "owner"),
    safeCall(rpc, address, COMMON, "admin"),
    safeCall(rpc, address, COMMON, "manager"),
    safeCall(rpc, address, COMMON, "oracle"),
    safeCall(rpc, address, COMMON, "comptroller"),
  ]);
  const totalSupplyUsd = (meta.totalSupply || 0) * 1;
  const externalTvl = ext ? unitsToNumber(ext[0], assetMeta.decimals) : null;
  const rawAssets = totalAssets?.[0] ?? getCash?.[0] ?? cash?.[0] ?? null;
  const liveAssets = rawAssets !== null ? unitsToNumber(rawAssets, assetMeta.decimals) : null;
  const liveBorrowedRaw = totalBorrows?.[0] ?? totalBorrowed?.[0] ?? totalDebt?.[0] ?? null;
  const liveBorrowed = liveBorrowedRaw !== null ? unitsToNumber(liveBorrowedRaw, assetMeta.decimals) : null;
  const tvlUsd = (liveAssets ?? meta.totalSupply ?? 0) + (externalTvl || 0);
  return {
    address,
    graph: graphRow,
    codePresent: code !== "0x",
    codeBytes: Math.max(0, (code.length - 2) / 2),
    eip1967Implementation: impl,
    symbol: meta.symbol,
    name: meta.name,
    decimals: meta.decimals,
    totalSupplyRaw: meta.totalSupplyRaw,
    totalSupply: meta.totalSupply,
    totalSupplyUsd: round(totalSupplyUsd, 2),
    externalTvlRaw: ext ? ext[0].toString() : null,
    externalTvlUsd: round(externalTvl, 2),
    liveAssetsUsd: round(liveAssets, 2),
    liveBorrowedUsd: round(liveBorrowed, 2),
    combinedTvlUsd: round(tvlUsd, 2),
    asset: normalizeAddress(asset?.[0]) || normalizeAddress(underlying?.[0]) || KASU.asset,
    loanToken: normalizeAddress(loanToken?.[0]),
    collateralToken: normalizeAddress(collateralToken?.[0]),
    borrowCapRaw: borrowCap ? borrowCap[0].toString() : null,
    supplyCapRaw: supplyCap ? supplyCap[0].toString() : null,
    paused: paused ? Boolean(paused[0]) : isPaused ? Boolean(isPaused[0]) : null,
    stopped: isStopped ? Boolean(isStopped[0]) : graphRow.isStopped ?? null,
    roles: {
      owner: owner ? normalizeAddress(owner[0]) : null,
      admin: admin ? normalizeAddress(admin[0]) : null,
      manager: manager ? normalizeAddress(manager[0]) : null,
      oracle: oracle ? normalizeAddress(oracle[0]) : null,
      comptroller: comptroller ? normalizeAddress(comptroller[0]) : null,
    },
    selectorHints: selectorHints(code),
  };
}

async function fetchDexRows(tokens) {
  const addresses = unique(tokens.map((row) => lowerAddress(row.address))).slice(0, MAX_DEX_TOKENS);
  if (!addresses.length) return [];
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addresses.join(",")}`, 30_000) || {};
  return (json.pairs || [])
    .filter((pair) => String(pair.chainId || "").toLowerCase() === "base")
    .map((pair) => ({
      token: tokens.find((t) => lowerAddress(t.address) === lowerAddress(pair.baseToken?.address) || lowerAddress(t.address) === lowerAddress(pair.quoteToken?.address))?.address || null,
      dexId: safeText(pair.dexId, 40),
      pairAddress: normalizeAddress(pair.pairAddress),
      baseSymbol: safeText(pair.baseToken?.symbol, 32),
      quoteSymbol: safeText(pair.quoteToken?.symbol, 32),
      liquidityUsd: round(pair.liquidity?.usd, 2),
      volume24hUsd: round(pair.volume?.h24, 2),
      priceUsd: round(pair.priceUsd, 10),
    }))
    .sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0));
}

const MATCH_FIELDS = ["asset", "token", "address", "vault", "market", "collateral", "loanToken", "underlying", "pool", "pairAddress", "oracle"];
function shallowSummary(row) {
  const out = {};
  for (const key of ["protocol", "chain", "chainId", "symbol", "assetSymbol", "vaultSymbol", "marketName", ...MATCH_FIELDS, "ltv", "lltv", "maxLtv", "liquidityUsd", "cashUsd", "borrowUsd", "routeLiquidityUsd", "routePositive", "watchCandidate", "status", "blocker"]) {
    if (row && Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

function collectMatches(value, addressSet, rows, limit, depth = 0) {
  if (!value || rows.length >= limit || depth > 10) return false;
  if (Array.isArray(value)) {
    let matched = false;
    for (const item of value) matched = collectMatches(item, addressSet, rows, limit, depth + 1) || matched;
    return matched;
  }
  if (typeof value !== "object") return addressSet.has(String(value).toLowerCase());
  let matched = false;
  for (const [key, child] of Object.entries(value)) {
    if (addressSet.has(String(key).toLowerCase()) || (typeof child !== "object" && addressSet.has(String(child).toLowerCase()))) matched = true;
  }
  for (const child of Object.values(value)) {
    if (rows.length >= limit) break;
    if (collectMatches(child, addressSet, rows, limit, depth + 1)) matched = true;
  }
  if (matched && rows.length < limit) rows.push(shallowSummary(value));
  return matched;
}

function collectLocalRows(addresses) {
  const set = new Set(unique(addresses.map(lowerAddress)).filter(Boolean));
  const rows = [];
  for (const [source, rel] of LOCAL_ARTIFACTS) {
    const file = path.join(WORKSPACE, rel);
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size > MAX_LOCAL_ARTIFACT_BYTES) continue;
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      const matches = [];
      collectMatches(json, set, matches, 25);
      for (const row of matches.slice(0, 25)) rows.push({ source, artifact: rel, ...row });
    } catch (_) {}
  }
  return rows;
}

function writeReport(out) {
  const s = out.summary;
  const poolRows = out.poolRows.slice(0, 20).map((row) => `| ${compactAddress(row.address)} | ${row.symbol || "?"} | ${row.codePresent} | ${formatUsd(row.combinedTvlUsd)} | ${formatUsd(row.liveAssetsUsd)} | ${formatUsd(row.externalTvlUsd)} | ${formatUsd(row.liveBorrowedUsd)} | ${row.paused ?? "n/a"} | ${Object.keys(row.selectorHints || {}).join(", ") || "none"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const dexRows = out.dexLiquidityRows.slice(0, 8).map((row) => `| ${compactAddress(row.token)} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} | ${row.priceUsd ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const localRows = out.localArtifactRows.slice(0, 12).map((row) => `| ${row.source} | ${row.symbol || row.assetSymbol || row.vaultSymbol || row.marketName || "?"} | ${compactAddress(row.asset || row.token || row.address || row.market || row.vault || row.collateral)} | ${formatUsd(row.routeLiquidityUsd ?? row.liquidityUsd ?? row.cashUsd ?? row.borrowUsd)} | ${row.routePositive ?? false} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const blockers = out.blockers.map((row) => `- ${row}`).join("\n");
  const required = out.requiredForRoutePositive.map((row) => `- ${row}`).join("\n");
  const content = `# 🟢 DORMANT - Kasu Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-kasu-phase0.js\`

Artifact: \`reports/raw/fast/kasu-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This bounded pass resolved the public Kasu adapter, discovered active Base pools from the public Goldsky subgraph, checked live Base bytecode and pool/external TVL state, searched for lending/liquidation/admin selector hints, checked public DEX liquidity for pool tokens, and joined exact pool/asset addresses against local consumer artifacts. No exact-positive borrow, liquidation, redemption, or unwind route was found.

## Summary

| Metric | Value |
|---|---:|
| Public TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Base TVL | ${formatUsd(s.baseTvlUsd)} |
| Pools discovered | \`${s.poolsDiscovered}\` |
| Pools with code | \`${s.poolsWithCode}\` |
| Material pool rows | \`${s.materialPoolRows}\` |
| Total pool TVL context | ${formatUsd(s.totalPoolTvlUsd)} |
| External TVL context | ${formatUsd(s.totalExternalTvlUsd)} |
| Live borrowed context | ${formatUsd(s.totalLiveBorrowedUsd)} |
| Loan-like graph collections | \`${s.loanLikeCollections}\` |
| Loan-like graph rows sampled | \`${s.loanLikeRows}\` |
| Local artifact rows | \`${s.localArtifactRows}\` |
| DEX rows | \`${s.dexLiquidityRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |
| Coverage classification | \`${s.coverageClassification}\` |

## Base Pool Rows

| Pool | Symbol | Code | Combined TVL | Live assets | External TVL | Live borrowed | Paused | Selector hints |
|---|---|---:|---:|---:|---:|---:|---:|---|
${poolRows}

## DEX Context

| Token | DEX | Pair | Liquidity USD | 24h volume USD | Price USD |
|---|---|---|---:|---:|---:|
${dexRows}

## Local Artifact Joins

| Source | Symbol/Market | Address | Liquidity/Cash | Route-positive |
|---|---|---|---:|---:|
${localRows}

## Blockers

${blockers}

## Required For Route-Positive

${required}

## Next Read-Only Step

Keep Kasu closed unless a material borrower/account-health source, accepted-value/oracle divergence, pool-token consumer, public liquidation path, or DEX/redemption exit appears with exact-positive economics.
`;
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const [apiRaw, adapterSource, rpc] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/kasu", 45_000),
    fetchText("https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/kasu/index.js", 30_000),
    resolveRpc(BASE_CHAIN_ID),
  ]);
  const metadata = protocolMetadata(apiRaw || {});
  const blockNumber = rpc ? await latestBlock(rpc) : null;
  const schema = await graphSchema();
  const graph = await graphPools(schema);
  const loanLike = await graphLoanLikeRows(schema);
  const [assetMeta, externalCode] = await Promise.all([
    tokenMeta(rpc, KASU.asset, { symbol: "USDC", decimals: 6 }),
    getCode(rpc, KASU.externalContract),
  ]);
  const externalImpl = externalCode !== "0x" ? await getImpl(rpc, KASU.externalContract, 10_000).catch(() => null) : null;
  const poolRows = [];
  for (const row of graph.rows) {
    const addr = normalizeAddress(row.id);
    if (!addr) continue;
    poolRows.push(await poolRow(rpc, row, assetMeta, externalCode));
  }
  poolRows.sort((a, b) => (asNumber(b.combinedTvlUsd) || 0) - (asNumber(a.combinedTvlUsd) || 0));
  const addressUniverse = unique([KASU.externalContract, ...poolRows.map((row) => row.address), ...poolRows.map((row) => row.loanToken), ...poolRows.map((row) => row.collateralToken)]);
  const [dexLiquidityRows, localArtifactRows] = await Promise.all([
    fetchDexRows(poolRows),
    Promise.resolve(collectLocalRows(addressUniverse)),
  ]);

  const materialPools = poolRows.filter((row) => (asNumber(row.combinedTvlUsd) || 0) >= MATERIAL_USD);
  const routePositive = localArtifactRows.filter((row) => row.routePositive === true || row.routePositive > 0).length;
  const watchCandidates = 0;
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-kasu-phase0.js",
    scope: "Read-only Kasu Base pool, external TVL, selector-hint, consumer-join, and DEX exit-liquidity Phase 0",
    safety: {
      publicApisOnlyForMetadata: true,
      rpcInventoryRead: Boolean(rpc),
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      calldataStored: false,
      borrowerAddressesStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive > 0,
      executableNow: false,
      signedActionJustified: false,
    },
    metadata,
    adapter: {
      module: metadata.module,
      tvlCodePath: metadata.tvlCodePath,
      rawSourceResolved: Boolean(adapterSource),
      baseGraphUrlResolved: Boolean(adapterSource?.includes(KASU.graphURL)),
      externalContractFromAdapter: adapterSource?.match(/0x[0-9a-fA-F]{40}/)?.[0] || null,
      methodology: "lendingPools(first: 1000, where: { isStopped: false }); sum pool totalSupply() plus externalTVLOfPool(pool)",
    },
    block: { chain: "Base", chainId: BASE_CHAIN_ID, number: blockNumber },
    deployments: {
      asset: assetMeta,
      externalContract: { address: KASU.externalContract, codePresent: externalCode !== "0x", codeBytes: Math.max(0, (externalCode.length - 2) / 2), eip1967Implementation: externalImpl, selectorHints: selectorHints(externalCode) },
      unsupportedChains: ["XDC", "Plume Mainnet"],
    },
    graph: {
      urlStored: false,
      schemaError: schema.error,
      lendingPoolFields: schema.lendingPoolFields,
      queryFieldsMatched: loanLike.collectionsTried,
      poolQueryFields: graph.fields,
      poolQueryError: graph.error,
      loanLikeCollections: loanLike.rows,
      loanLikeErrors: loanLike.errors,
    },
    poolRows,
    dexLiquidityRows,
    localArtifactRows,
    summary: {
      defillamaCurrentTvlUsd: round(metadata.tvlUsd, 2),
      baseTvlUsd: round(metadata.baseTvlUsd, 2),
      poolsDiscovered: graph.rows.length,
      poolsWithCode: poolRows.filter((row) => row.codePresent).length,
      materialPoolRows: materialPools.length,
      totalPoolTvlUsd: round(poolRows.reduce((acc, row) => acc + (asNumber(row.combinedTvlUsd) || 0), 0), 2),
      totalExternalTvlUsd: round(poolRows.reduce((acc, row) => acc + (asNumber(row.externalTvlUsd) || 0), 0), 2),
      totalLiveBorrowedUsd: round(poolRows.reduce((acc, row) => acc + (asNumber(row.liveBorrowedUsd) || 0), 0), 2),
      poolsWithBorrowSelectorHints: poolRows.filter((row) => row.selectorHints?.borrowRepay?.length).length,
      poolsWithLiquidationSelectorHints: poolRows.filter((row) => row.selectorHints?.liquidate?.length).length,
      loanLikeCollections: loanLike.rows.length,
      loanLikeRows: loanLike.rows.reduce((acc, row) => acc + (row.rows?.length || 0), 0),
      localArtifactRows: localArtifactRows.length,
      dexLiquidityRows: dexLiquidityRows.length,
      topDexLiquidityUsd: round(dexLiquidityRows[0]?.liquidityUsd, 2),
      watchCandidates,
      routePositive,
      executableNow: false,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      forkGate: routePositive > 0 ? "route-positive-needs-fork-proof" : "closed-route-positive-zero",
      status: routePositive > 0 ? "kasu-route-positive-needs-proof" : "kasu-phase0-no-route-positive",
    },
    blockers: [
      "Kasu Base TVL is pool/external-management context from a public subgraph plus totalSupply/externalTVLOfPool, not proof of a permissionless extraction path",
      "No exact Kasu pool-token or external-contract join in local consumer artifacts mapped to route-positive economics; generic USDC reserve joins are context-only",
      "No public DEX exit liquidity was proven for Kasu pool tokens in this pass",
      "No decoded borrower/account-health or liquidation-profit route with exact repay/acquire/collateral-exit economics was resolved",
      "XDC and Plume Mainnet are outside current sanitized RPC support and are not closed route-negative",
      "No fork extraction proof and no signed-action justification exist",
    ],
    requiredForRoutePositive: [
      "specific Kasu pool or borrower state exposes a permissionless borrow, liquidation, redemption, or withdrawal path",
      "account health, oracle/accepted value, or pool accounting is attacker-favorable in current live state",
      "acquisition, repay/borrow/redeem/liquidate action, and exit/unwind liquidity are exact-quoted positive after fees, gas, and slippage",
      "unsupported XDC/Plume scope is resolved only with sanitized RPC endpoints and chain presets before route-negative closure",
      "fork extraction proof demonstrates measured net profit",
    ],
    nextReadOnlyStep: "Keep Kasu closed unless a material borrower/account-health source, accepted-value/oracle divergence, pool-token consumer, public liquidation path, or DEX/redemption exit appears with exact-positive economics.",
  };
  writeJson(RAW_OUT, out);
  writeReport(out);
  if (!QUIET) {
    console.log(`Kasu Phase0: tvl=${formatUsd(out.summary.defillamaCurrentTvlUsd)} pools=${out.summary.poolsDiscovered} material=${out.summary.materialPoolRows} borrowed=${formatUsd(out.summary.totalLiveBorrowedUsd)} dexRows=${out.summary.dexLiquidityRows} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 1000));
  process.exit(1);
});
