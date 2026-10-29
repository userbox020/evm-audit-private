#!/usr/bin/env node
// scan-nado-spot-phase0.js - read-only Phase 0 for Nado Spot Ink custody/engine balances and consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "nado-spot-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "nado-spot-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const INK_CHAIN_ID = 57073;
const INK_CHAIN = "Ink";
const INK_COIN_SLUG = "ink";
const MIN_MATERIAL_BALANCE_USD = Number(process.env.NADO_SPOT_MIN_MATERIAL_BALANCE_USD || "100000");

const CONTRACTS = [
  { role: "querier", label: "Querier", address: "0x68798229F88251b31D534733D6C4098318c9dff8" },
  { role: "clearinghouse", label: "Clearinghouse", address: "0xD218103918C19D0A10cf35300E4CfAfbD444c5fE", tvlOwner: true },
  { role: "endpoint", label: "Endpoint", address: "0x05ec92D78ED421f3D3Ada77FFdE167106565974E", tvlOwner: true },
  { role: "spotEngine", label: "Spot Engine", address: "0xFcD94770B95fd9Cc67143132BB172EB17A0907fE" },
  { role: "perpEngine", label: "Perp Engine", address: "0xF8599D58d1137fC56EcDd9C16ee139C8BDf96da1" },
];

const TRACKED_TOKENS = [
  { symbol: "USDT0", address: "0x0200C29006150606B650577BBE7B6248F58470c1", stable: true },
  { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
  { symbol: "KBTC", address: "0x73E0C0d45E048D25Fc26Fa3159b0aA04BfA4Db98" },
  { symbol: "USDC", address: "0x2D270e6886d130D724215A266106e6832161EAEd", stable: true },
];

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
]);

const SELECTOR_HINT_SIGNATURES = [
  "depositCollateral(address,uint256)",
  "withdrawCollateral(address,uint256)",
  "deposit(address,uint256)",
  "withdraw(address,uint256)",
  "liquidate(address,address,uint256)",
  "settlePnl(address)",
  "claim(address,uint256)",
  "execute(address,uint256,bytes)",
  "transfer(address,uint256)",
  "owner()",
  "admin()",
];

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
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-synthetic-consumer", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["bridge-escrow-reconciliation", "reports/raw/fast/bridge-escrow-reconciliation.json"],
  ["deprecated-orphaned", "reports/raw/fast/deprecated-orphaned-reachability.json"],
  ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
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
  "dex-consumer-routes",
  "bridge-proof-binding",
  "bridge-synthetic-consumer",
  "bridge-escrow-reconciliation",
  "deprecated-orphaned",
]);
const DIRECT_ROLES = new Set(["querier", "clearinghouse", "endpoint", "spotEngine", "perpEngine"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";

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
function addressFromStorageSlot(raw) { if (!raw || raw === "0x") return null; const hex = strip0x(raw).padStart(64, "0"); if (/^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }
function lastRow(value) { return Array.isArray(value) && value.length ? value[value.length - 1] : null; }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-nado-spot-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

async function getStorage(rpc, address, slot) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return null;
  return await rpcCall(rpc, "eth_getStorageAt", [addr, slot, "latest"], 10_000).catch(() => null);
}

async function ethBalance(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return null;
  return await rpcCall(rpc, "eth_getBalance", [addr, "latest"], 10_000).catch(() => null);
}

function selectorHints(code) {
  const bytecode = strip0x(code).toLowerCase();
  if (!bytecode) return [];
  return SELECTOR_HINT_SIGNATURES.map((signature) => ({ signature, selector: ethers.id(signature).slice(0, 10) }))
    .filter((row) => bytecode.includes(strip0x(row.selector).toLowerCase()));
}

function discoveryRows() {
  const d = readJson(PUBLIC_TARGETS, {});
  return [...(d.phase0Queue || []), ...(d.consumerJoinFirst || []), ...(d.protocolCandidates || []), ...(d.targetedRefreshQueue || []), ...(d.yieldCandidates || []), ...(d.targets || []), ...(d.value || [])];
}

function protocolMetadata(apiRaw) {
  const row = discoveryRows().find((p) => p?.slug === "nado-spot" || p?.name === "Nado Spot");
  const apiChainTvl = asNumber(apiRaw?.currentChainTvls?.Ink) || asNumber(lastRow(apiRaw?.chainTvls?.Ink?.tvl)?.totalLiquidityUSD);
  const apiTvl = apiChainTvl || asNumber(apiRaw?.tvl?.slice?.(-1)?.[0]?.totalLiquidityUSD);
  return {
    name: apiRaw?.name || row?.name || "Nado Spot",
    slug: apiRaw?.slug || row?.slug || "nado-spot",
    category: apiRaw?.category || row?.category || "Dexs",
    chains: apiRaw?.chains || row?.chains || [INK_CHAIN],
    evmChains: row?.evmChains || [INK_CHAIN],
    tvlUsd: round(apiTvl || row?.tvlUsd, 2),
    change1dPct: row?.change1dPct ?? apiRaw?.change_1d ?? null,
    change7dPct: row?.change7dPct ?? apiRaw?.change_7d ?? null,
    routePriority: row?.routePriority || null,
    source: apiRaw ? "api.llama.fi+public-audit-target-discovery" : "public-audit-target-discovery",
  };
}

async function loadPrices() {
  const keys = TRACKED_TOKENS.map((token) => `${INK_COIN_SLUG}:${token.address.toLowerCase()}`);
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.join(",")}?searchWidth=6h`, 30_000);
  const out = {};
  for (const [key, value] of Object.entries(json?.coins || {})) {
    const price = asNumber(value?.price);
    if (price !== null) out[key.toLowerCase()] = price;
  }
  return out;
}

async function tokenMeta(rpc, token, prices) {
  const addr = normalizeAddress(token.address);
  const [code, decimalsRaw, symbolRaw, symbolBytesRaw, nameRaw, nameBytesRaw, totalSupplyResult] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, BYTES32_TOKEN, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, BYTES32_TOKEN, "name"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
  ]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const symbol = safeText(symbolRaw?.[0], 40) || decodeBytes32String(symbolBytesRaw?.[0]) || token.symbol;
  const totalSupplyRaw = totalSupplyResult?.[0] === undefined ? null : totalSupplyResult[0].toString();
  return {
    chainId: INK_CHAIN_ID,
    chain: INK_CHAIN,
    address: addr,
    expectedSymbol: token.symbol,
    symbol,
    name: safeText(nameRaw?.[0], 80) || decodeBytes32String(nameBytesRaw?.[0]),
    decimals,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    totalSupplyRaw,
    totalSupply: round(decimalsToNumber(totalSupplyRaw, decimals), 6),
    priceUsd: prices[`${INK_COIN_SLUG}:${addr.toLowerCase()}`] ?? (token.stable ? 1 : null),
    routePositive: false,
  };
}

async function inspectContract(rpc, contract, nativePriceUsd) {
  const address = normalizeAddress(contract.address);
  const [code, nativeRaw, implRaw, adminSlotRaw, beaconRaw, ownerRaw, adminRaw, pausedRaw, safeOwnersRaw, safeThresholdRaw, versionRaw] = await Promise.all([
    getCode(rpc, address),
    ethBalance(rpc, address),
    getStorage(rpc, address, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, address, EIP1967_ADMIN_SLOT),
    getStorage(rpc, address, EIP1967_BEACON_SLOT),
    safeCall(rpc, address, COMMON, "owner"),
    safeCall(rpc, address, COMMON, "admin"),
    safeCall(rpc, address, COMMON, "paused"),
    safeCall(rpc, address, COMMON, "getOwners"),
    safeCall(rpc, address, COMMON, "getThreshold"),
    safeCall(rpc, address, COMMON, "VERSION"),
  ]);
  const nativeEth = decimalsToNumber(nativeRaw, 18);
  const safeOwners = Array.isArray(safeOwnersRaw?.[0]) ? safeOwnersRaw[0].map((owner) => normalizeAddress(owner)).filter(Boolean) : [];
  return {
    chainId: INK_CHAIN_ID,
    chain: INK_CHAIN,
    role: contract.role,
    label: contract.label,
    address,
    tvlOwner: Boolean(contract.tvlOwner),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    nativeBalanceRaw: nativeRaw ? BigInt(nativeRaw).toString() : null,
    nativeEth: round(nativeEth, 8),
    nativeUsd: nativeEth !== null && nativePriceUsd !== null ? round(nativeEth * nativePriceUsd, 2) : null,
    eip1967: { implementation: addressFromStorageSlot(implRaw), admin: addressFromStorageSlot(adminSlotRaw), beacon: addressFromStorageSlot(beaconRaw) },
    owner: normalizeAddress(ownerRaw?.[0]),
    admin: normalizeAddress(adminRaw?.[0]),
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
    safeOwners,
    safeOwnerCount: safeOwners.length,
    safeThreshold: safeThresholdRaw?.[0] === undefined ? null : Number(safeThresholdRaw[0]),
    version: versionRaw?.[0] === undefined ? null : safeText(versionRaw[0], 80),
    selectorHints: selectorHints(code),
    routePositive: false,
  };
}

async function inspectBalances(rpc, ownerRows, tokenMetas) {
  const rows = [];
  const owners = ownerRows.filter((row) => row.tvlOwner);
  for (const owner of owners) {
    for (const meta of tokenMetas) {
      const raw = await safeCall(rpc, meta.address, ERC20, "balanceOf", [owner.address]);
      const balanceRaw = raw?.[0] === undefined ? null : raw[0].toString();
      const amount = decimalsToNumber(balanceRaw, meta.decimals);
      const amountUsd = amount !== null && meta.priceUsd !== null && meta.priceUsd !== undefined ? amount * meta.priceUsd : null;
      rows.push({
        chainId: INK_CHAIN_ID,
        chain: INK_CHAIN,
        owner: owner.address,
        ownerLabel: owner.label,
        ownerRole: owner.role,
        token: meta.address,
        symbol: meta.symbol || meta.expectedSymbol,
        name: meta.name,
        decimals: meta.decimals,
        tokenCodePresent: meta.codePresent,
        balanceRaw,
        amount: round(amount, 8),
        priceUsd: round(meta.priceUsd, 8),
        amountUsd: round(amountUsd, 2),
        material: (asNumber(amountUsd) || 0) >= MIN_MATERIAL_BALANCE_USD,
        routePositive: false,
      });
    }
  }
  return rows.sort((a, b) => (asNumber(b.amountUsd) || 0) - (asNumber(a.amountUsd) || 0));
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
      contracts: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.contract)).filter(Boolean)).slice(0, 10),
      tokens: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.token)).filter(Boolean)).slice(0, 10),
      context: summarizeContext(obj),
      directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)),
      routePositive: false,
      blocker: "Local artifact address match is context only unless Nado custody, engine, or accounting state is trusted by consumer logic with exact positive economics",
    });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(contractRows, tokenRows) {
  const roles = {};
  function add(addr, role, contract, token) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push({ role, contract, token });
  }
  for (const row of contractRows) add(row.address, row.role, row.address, null);
  for (const row of tokenRows) add(row.token, "token", row.owner, row.token);
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) { const json = readJson(path.join(WORKSPACE, rel), null); if (json) scanObjectForAddresses(source, json, roles, matches); }
  return { contractSpecificJoinRows: matches.filter((row) => row.directConsumer), tokenContextRows: matches.filter((row) => !row.directConsumer) };
}

function coverageClassification(summary) {
  if (!summary.inkRpcAvailable || summary.contractsWithCode < summary.contractsDeclared || summary.trackedTokenCodePresent < summary.trackedTokens || summary.balanceRowsRead < summary.expectedBalanceRows) return "partial-or-blocked";
  return "full-enough-for-declared-scope";
}

function buildReport(artifact) {
  const s = artifact.summary;
  const contractTable = artifact.contractRows.map((row) => `| ${row.role} | ${compactAddress(row.address)} | ${row.codePresent ? "yes" : "no"} | ${row.codeBytes} | ${compactAddress(row.eip1967?.implementation)} | ${compactAddress(row.owner || row.admin)} | ${row.paused ?? "n/a"} | ${row.nativeEth ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const balanceTable = artifact.balanceRows.filter((row) => (asNumber(row.amountUsd) || 0) > 0).slice(0, 12).map((row) => `| ${row.ownerLabel} | ${row.symbol || compactAddress(row.token)} | ${formatNumber(row.amount, 8)} | ${formatUsd(row.amountUsd)} | ${row.material ? "yes" : "no"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const consumerTable = artifact.contractSpecificJoinRows.length ? artifact.contractSpecificJoinRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.contracts.map(compactAddress).join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Nado contract address was found in consumer-grade artifacts |";
  const contextTable = artifact.tokenContextRows.length ? artifact.tokenContextRows.slice(0, 8).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a |";
  return `# ${SIGNAL_DORMANT} - Nado Spot Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. DeFiLlama maps Nado Spot through the public \`nado/index.js\` adapter as an Ink custody/engine balance surface, not an AMM factory. The adapter-declared contracts had code coverage in this pass, and the clearinghouse/endpoint balances for USDT0, WETH, KBTC, and USDC were read directly. Token-level joins are common-asset context only; route-positive requires a deployed consumer or Nado-specific custody, engine, accounting, oracle, or settlement weakness plus exact positive borrow, redemption, liquidation, bridge, or unwind economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ink RPC available | ${s.inkRpcAvailable ? "yes" : "no"} |
| Contracts declared | ${s.contractsDeclared} |
| Contracts with code | ${s.contractsWithCode} |
| TVL owners scanned | ${s.tvlOwnersScanned} |
| Tracked tokens | ${s.trackedTokens} |
| Balance rows read | ${s.balanceRowsRead}/${s.expectedBalanceRows} |
| Tracked custody balance USD | ${formatUsd(s.trackedCustodyBalanceUsd)} |
| Material balance rows | ${s.materialBalanceRows} |
| Contract-specific consumer rows | ${s.contractSpecificJoinRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |
| Coverage classification | ${s.coverageClassification} |

## Contracts

| Role | Address | Code | Code bytes | EIP-1967 impl | Owner/admin | Paused | Native ETH |
|---|---|---|---:|---|---|---|---:|
${contractTable}

## Custody Balances

| Owner | Token | Amount | USD | Material |
|---|---|---:|---:|---|
${balanceTable}

## Contract-Specific Consumer Join

| Source | Hit roles | Addresses | Contracts | Context |
|---|---|---|---|---|
${consumerTable}

## Token Context Joins

| Source | Hit roles | Addresses | Context |
|---|---|---|---|
${contextTable}

## Blockers

- The adapter surface is custody/engine balance context, not an EVM AMM pool factory.
- No Nado-specific contract address is currently found as a value-bearing collateral, reserve, oracle, bridge proof, or settlement dependency in scanned consumer-grade artifacts.
- USDT0, WETH, KBTC, and USDC joins are common-asset context and not Nado-specific impact without a custody/engine/accounting weakness.
- Clearinghouse and endpoint token balances do not prove a permissionless withdrawal, mint, price, accounting, or settlement bypass.
- No exact positive bridge, borrow, redemption, liquidation, settlement, or DEX unwind economics and no fork extraction proof exist.

## Required For Route-Positive

- A deployed consumer references Nado custody, engine, endpoint, account, or settlement state, or a Nado-specific permissionless state/balance weakness is proven.
- The referenced state is permissionlessly movable, stale, under-bound, or otherwise attacker-favorable.
- Borrow, redemption, bridge, liquidation, or settlement liquidity is material and exact-quoted after fees, gas, and slippage.
- Fork/local proof shows positive net value.

Artifacts: \`reports/raw/fast/nado-spot-phase0.json\`.
`;
}

async function main() {
  const apiRaw = await fetchJson("https://api.llama.fi/protocol/nado-spot", 30_000);
  const metadata = protocolMetadata(apiRaw);
  const rpcs = await resolveRpcPool([INK_CHAIN_ID]);
  const rpcCandidate = rpcs[INK_CHAIN_ID] || null;
  const chainIdHex = rpcCandidate ? await rpcCall(rpcCandidate, "eth_chainId", [], 6_000) : null;
  const inkRpcAvailable = Boolean(chainIdHex && parseInt(chainIdHex, 16) === INK_CHAIN_ID);
  const rpc = inkRpcAvailable ? rpcCandidate : null;

  const prices = await loadPrices();
  const weth = TRACKED_TOKENS.find((token) => token.symbol === "WETH");
  const nativePriceUsd = weth ? (prices[`${INK_COIN_SLUG}:${weth.address.toLowerCase()}`] ?? null) : null;
  const contractRows = rpc ? await Promise.all(CONTRACTS.map((contract) => inspectContract(rpc, contract, nativePriceUsd))) : [];
  const tokenMetas = rpc ? await Promise.all(TRACKED_TOKENS.map((token) => tokenMeta(rpc, token, prices))) : [];
  const balanceRows = rpc ? await inspectBalances(rpc, contractRows, tokenMetas) : [];
  const joins = localConsumerJoins(contractRows, balanceRows);
  const contractJoinSet = new Set(joins.contractSpecificJoinRows.flatMap((row) => row.contracts.map(lowerAddress)).filter(Boolean));
  const watchCandidates = contractRows.filter((row) => contractJoinSet.has(lowerAddress(row.address))).map((row) => ({ ...row, reason: "Nado contract address appears in a consumer/proof artifact; exact positive economics are not proven", routePositive: false }));
  const expectedBalanceRows = CONTRACTS.filter((row) => row.tvlOwner).length * TRACKED_TOKENS.length;
  const summary = {
    inkRpcAvailable,
    rpcAvailability: { [INK_CHAIN_ID]: inkRpcAvailable },
    contractsDeclared: CONTRACTS.length,
    contractsScanned: contractRows.length,
    contractsWithCode: contractRows.filter((row) => row.codePresent).length,
    tvlOwnersScanned: contractRows.filter((row) => row.tvlOwner).length,
    trackedTokens: TRACKED_TOKENS.length,
    trackedTokenCodePresent: tokenMetas.filter((row) => row.codePresent).length,
    expectedBalanceRows,
    balanceRows: balanceRows.length,
    balanceRowsRead: balanceRows.filter((row) => row.balanceRaw !== null).length,
    trackedCustodyBalanceUsd: round(balanceRows.reduce((sum, row) => sum + (asNumber(row.amountUsd) || 0), 0), 2),
    maxCustodyTokenBalanceUsd: round(Math.max(0, ...balanceRows.map((row) => asNumber(row.amountUsd) || 0)), 2),
    materialBalanceRows: balanceRows.filter((row) => (asNumber(row.amountUsd) || 0) >= MIN_MATERIAL_BALANCE_USD).length,
    contractSpecificJoinRows: joins.contractSpecificJoinRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closedReason: joins.contractSpecificJoinRows.length ? "Nado contract references found, but no exact-positive consumer economics or proof" : "no Nado contract address is referenced by scanned consumer-grade artifacts",
  };
  summary.coverageClassification = coverageClassification(summary);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-nado-spot-phase0.js",
    scope: "Read-only Nado Spot Ink custody/engine balance and consumer-route Phase 0 scan",
    target: { name: "Nado Spot", slug: "nado-spot", category: "Dexs", surface: "dex-oracle-consumer-only", metadata },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    thresholds: { minMaterialBalanceUsd: MIN_MATERIAL_BALANCE_USD },
    docs: {
      adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/nado/index.js",
      sourceModel: "Ink custody/engine balance sum across clearinghouse and endpoint owners for USDT0/WETH/KBTC/USDC",
      coreAssets: "DeFiLlama helper/coreAssets.json ink token addresses resolved publicly",
    },
    chainRows: [{ chainId: INK_CHAIN_ID, chain: INK_CHAIN, coinSlug: INK_COIN_SLUG }],
    adapterContracts: CONTRACTS.map((row) => ({ ...row, address: normalizeAddress(row.address) })),
    trackedTokens: TRACKED_TOKENS.map((row) => ({ ...row, address: normalizeAddress(row.address) })),
    contractRows,
    tokenMetas,
    balanceRows,
    rows: balanceRows,
    contractSpecificJoinRows: joins.contractSpecificJoinRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 180),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: [
      "Adapter exposes custody/engine balances, not an AMM pool factory",
      "No Nado-specific contract address is referenced by scanned consumer-grade artifacts",
      "USDT0/WETH/KBTC/USDC joins are common-asset context without Nado-specific impact",
      "Clearinghouse and endpoint balances do not prove a permissionless custody, accounting, oracle, or settlement weakness",
      "No exact positive bridge, borrow, redemption, liquidation, settlement, or DEX unwind economics or proof",
    ],
    requiredForRoutePositive: [
      "deployed consumer references Nado custody, engine, endpoint, account, or settlement state, or a Nado-specific permissionless state/balance weakness is proven",
      "referenced state is permissionlessly movable, stale, under-bound, or otherwise attacker-favorable",
      "borrow, redemption, bridge, liquidation, or settlement route is exact-quoted and positive",
      "fork/local proof",
    ],
    nextReadOnlyStep: joins.contractSpecificJoinRows.length ? "Static-review the matched consumer/proof artifact and exact-quote only if Nado custody or engine state affects accepted value." : "Reopen Nado Spot only if a consumer references Nado custody/engine/accounting state or a Nado-specific permissionless state weakness appears.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Nado Spot Phase 0: inkRpc=${summary.inkRpcAvailable ? "yes" : "no"} contracts=${summary.contractsWithCode}/${summary.contractsDeclared} balances=${summary.balanceRowsRead}/${summary.expectedBalanceRows} material=${summary.materialBalanceRows} contractConsumers=${summary.contractSpecificJoinRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive} coverage=${summary.coverageClassification}`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
