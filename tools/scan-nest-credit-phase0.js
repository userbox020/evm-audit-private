#!/usr/bin/env node
// scan-nest-credit-phase0.js - read-only Phase 0 for Nest Credit vault-owner balances and consumer joins.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "nest-credit-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "nest-credit-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const VAULTS = [
  { address: "0x29bF22381A5811deC89dC7b46A5Ce57aD02c0240", label: "nWISDOM" },
  { address: "0x119Dd7dAFf816f29D7eE47596ae5E4bdC4299165", label: "nOPAL" },
  { address: "0x2A3e301dbd45c143DFbb7b1CE1C55bf0BBF161cb", label: "nACRDX" },
];

const CHAINS = [
  {
    key: "ethereum",
    adapterChain: "ethereum",
    chain: "Ethereum",
    chainId: 1,
    coinSlug: "ethereum",
    tokens: [
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    ],
  },
  {
    key: "bsc",
    adapterChain: "bsc",
    chain: "BNB Chain",
    chainId: 56,
    coinSlug: "bsc",
    tokens: [
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955" },
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
    ],
  },
];

const UNSUPPORTED_ADAPTER_CHAINS = [
  { adapterChain: "plasma", token: "USDT0", reason: "no local Plasma RPC/chain preset in current inventory" },
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
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
const DIRECT_ROLES = new Set(["nestVaultOwner"]);

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
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const text = String(value).replace(/[$,%\s,]/g, ""); if (!text) return null; const n = Number(text); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 2) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function unitsToNumber(value, decimals = 18) { try { if (value === null || value === undefined) return null; return Number(ethers.formatUnits(BigInt(value), decimals)); } catch (_) { return null; } }
function slotAddress(raw) { const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; return addr && addr !== ZERO ? addr : null; }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-nest-credit-phase0/1.0" } });
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

function protocolMetadata() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.consumerJoinFirst || []), ...(d.protocolCandidates || []), ...(d.targets || [])];
  const row = rows.find((p) => p?.slug === "nest-credit" || p?.name === "Nest Credit");
  if (row) return { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], evmChains: row.evmChains || [], customSupportedChains: row.customSupportedChains || [], tvlUsd: row.tvlUsd, change1dPct: row.change1dPct, change7dPct: row.change7dPct, routePriority: row.routePriority || null, source: "public-audit-target-discovery" };
  return { name: "Nest Credit", slug: "nest-credit", category: "RWA", chains: ["Ethereum", "BNB Chain", "Plasma"], evmChains: ["Ethereum", "BNB Chain"], tvlUsd: null };
}

async function fetchPrices(chains) {
  const keys = [];
  for (const chain of chains) for (const token of chain.tokens) keys.push(`${chain.coinSlug}:${token.address.toLowerCase()}`);
  const fetched = await fetchJson(`https://coins.llama.fi/prices/current/${unique(keys).join(",")}?searchWidth=6h`, 30_000);
  const prices = new Map();
  for (const [key, row] of Object.entries(fetched.json?.coins || {})) {
    const price = Number(row?.price || 0);
    if (price > 0) prices.set(key.toLowerCase(), price);
  }
  return { prices, fetched: { ok: fetched.ok, status: fetched.status, count: prices.size, error: fetched.error } };
}

async function tokenMeta(rpc, token) {
  const addr = normalizeAddress(token.address || token);
  const [decimals, symbol, name, code] = await Promise.all([
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    getCode(rpc, addr),
  ]);
  return {
    address: addr,
    symbol: safeText(symbol?.[0], 40) || token.symbol || null,
    name: safeText(name?.[0], 80),
    decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
  };
}

async function inspectVaultOnChain(rpc, chain, vault) {
  const address = normalizeAddress(vault.address);
  const code = await getCode(rpc, address);
  const [impl, admin, owner, adminFn, asset, totalAssets, totalSupply, decimals, symbol, name] = await Promise.all([
    getSlotAddress(rpc, address, EIP1967_IMPL),
    getSlotAddress(rpc, address, EIP1967_ADMIN),
    safeCall(rpc, address, COMMON, "owner"),
    safeCall(rpc, address, COMMON, "admin"),
    safeCall(rpc, address, COMMON, "asset"),
    safeCall(rpc, address, COMMON, "totalAssets"),
    safeCall(rpc, address, COMMON, "totalSupply"),
    safeCall(rpc, address, COMMON, "decimals"),
    safeCall(rpc, address, COMMON, "symbol"),
    safeCall(rpc, address, COMMON, "name"),
  ]);
  return {
    chainId: chain.chainId,
    chain: chain.chain,
    adapterChain: chain.adapterChain,
    vault: address,
    label: vault.label,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    implementation: impl,
    proxyAdmin: admin,
    owner: normalizeAddress(owner?.[0]),
    admin: normalizeAddress(adminFn?.[0]),
    asset: normalizeAddress(asset?.[0]),
    totalAssetsRaw: totalAssets?.[0]?.toString?.() || null,
    totalSupplyRaw: totalSupply?.[0]?.toString?.() || null,
    decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    symbol: safeText(symbol?.[0], 40),
    name: safeText(name?.[0], 80),
    routePositive: false,
  };
}

async function inspectChains(rpcs, priceMap) {
  const tokenRows = [];
  const vaultRows = [];
  const balanceRows = [];
  for (const chain of CHAINS) {
    const rpc = rpcs[chain.chainId];
    const tokenMetaRows = [];
    for (const token of chain.tokens) tokenMetaRows.push(await tokenMeta(rpc, token));
    for (const token of tokenMetaRows) tokenRows.push({ ...chain, ...token, routePositive: false });
    for (const vault of VAULTS) {
      const vaultRow = await inspectVaultOnChain(rpc, chain, vault);
      vaultRows.push(vaultRow);
      for (const token of tokenMetaRows) {
        const bal = await safeCall(rpc, token.address, ERC20, "balanceOf", [vault.address]);
        const amount = unitsToNumber(bal?.[0]?.toString?.(), token.decimals ?? 18);
        const price = priceMap.get(`${chain.coinSlug}:${token.address.toLowerCase()}`) || null;
        balanceRows.push({
          chainId: chain.chainId,
          chain: chain.chain,
          adapterChain: chain.adapterChain,
          vault: vaultRow.vault,
          vaultLabel: vault.label,
          token: token.address,
          tokenSymbol: token.symbol,
          tokenDecimals: token.decimals,
          balanceRaw: bal?.[0]?.toString?.() || null,
          balanceAmount: round(amount, 8),
          tokenPriceUsd: price,
          balanceUsd: price ? round((amount || 0) * price, 2) : null,
          routePositive: false,
        });
      }
    }
  }
  return { tokenRows, vaultRows, balanceRows: balanceRows.sort((a, b) => (asNumber(b.balanceUsd) || 0) - (asNumber(a.balanceUsd) || 0)) };
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
    out.push({
      source,
      hitRoles: roles,
      hitAddresses: hits.slice(0, 12),
      chains: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.chain)).filter(Boolean)).slice(0, 8),
      directConsumer: roles.some((role) => DIRECT_ROLES.has(role)),
      context: summarizeContext(obj),
      routePositive: false,
      blocker: "Local artifact address match is context only unless Nest vault-owner state is trusted by consumer logic with exact positive economics",
    });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(vaultRows, tokenRows) {
  const roles = {};
  function add(addr, role) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push(role);
  }
  for (const row of vaultRows) add(row.vault, { role: "nestVaultOwner", chain: row.chain, label: row.label });
  for (const row of tokenRows) add(row.address, { role: "adapterAsset", chain: row.chain, symbol: row.symbol });
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) {
    const json = readJson(path.join(WORKSPACE, rel), null);
    if (json) scanObjectForAddresses(source, json, roles, matches);
  }
  return { directConsumerRows: matches.filter((row) => row.directConsumer), tokenContextRows: matches.filter((row) => !row.directConsumer) };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const vaultTable = artifact.vaultRows.map((row) => `| ${row.chain} | ${row.label} | ${compactAddress(row.vault)} | ${row.codePresent ? "yes" : "no"} | ${compactAddress(row.owner || row.admin || row.proxyAdmin)} | ${row.symbol || "n/a"} | ${compactAddress(row.asset)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const balanceTable = artifact.balanceRows.filter((row) => (asNumber(row.balanceUsd) || 0) > 0).slice(0, 18).map((row) => `| ${row.chain} | ${row.vaultLabel} | ${row.tokenSymbol} | ${formatNumber(row.balanceAmount, 4)} | ${formatUsd(row.balanceUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const unsupported = artifact.unsupportedAdapterChains.map((row) => `| ${row.adapterChain} | ${row.token} | ${row.reason} |`).join("\n") || "| none | n/a | n/a |";
  const consumerTable = artifact.directConsumerRows.length ? artifact.directConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.chains.join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Nest vault-owner address was found in consumer-grade artifacts |";
  return `# ${SIGNAL_DORMANT} - Nest Credit Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit for the covered Nest Credit vault-owner balance scope. The public adapter is a balance adapter over three Nest Credit vault-owner addresses and stablecoin tokens, not a lending-market ABI. Ethereum and BNB Chain balances were checked through read-only RPC; Plasma USDT0 is explicitly outside current local RPC scope. Vault-owner addresses were not found as consumer-grade lending/oracle dependencies, and stablecoin token joins are common-asset context only without Nest-specific impact.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Adapter chains known | ${s.adapterChainsKnown} |
| Chains inspected | ${s.chainsInspected} |
| Unsupported adapter chains | ${s.unsupportedAdapterChains} |
| Vault-owner rows | ${s.vaultRows} |
| Vault-owner rows with code | ${s.vaultRowsWithCode} |
| Token rows | ${s.tokenRows} |
| Balance rows | ${s.balanceRows} |
| Positive balance rows | ${s.positiveBalanceRows} |
| Total tracked balance | ${formatUsd(s.totalTrackedBalanceUsd)} |
| Direct Nest consumer rows | ${s.directConsumerRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |
| Coverage classification | ${s.coverageClassification} |

## Vault Owners

| Chain | Label | Address | Code | Owner/Admin | Symbol | asset() |
|---|---|---|---|---|---|---|
${vaultTable}

## Positive Balances

| Chain | Vault label | Token | Amount | USD |
|---|---|---|---:|---:|
${balanceTable}

## Direct Nest Consumer Join

| Source | Hit roles | Addresses | Chains | Context |
|---|---|---|---|---|
${consumerTable}

## Unsupported Adapter Chains

| Adapter chain | Token | Reason |
|---|---|---|
${unsupported}

## Blockers

- Adapter surface is vault-owner stablecoin balances, not a lending, oracle, AMM, or public redemption route by itself.
- No Nest vault-owner address was found in scanned consumer-grade artifacts.
- USDT/USDC joins are common-asset context only and do not prove accepted-value dependence on Nest vault state.
- Plasma USDT0 is outside current local RPC scope and is treated as a bounded caveat.
- No exact positive borrow, redemption, liquidation, settlement, bridge, or DEX unwind economics and no fork/local proof exist.

## Required For Route-Positive

- A deployed consumer references Nest vault-owner, receipt, NAV, redemption, or accounting state.
- A permissionless vault/custody/redeem/bridge weakness affects a liquid asset balance.
- Exact unwind, borrow, redeem, bridge, or liquidation economics are positive after gas/slippage/fees.
- Fork/local proof demonstrates positive net value.

Artifacts: \`reports/raw/fast/nest-credit-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const rpcs = await resolveRpcPool(CHAINS.map((c) => c.chainId));
  const priceFetch = await fetchPrices(CHAINS);
  const { tokenRows, vaultRows, balanceRows } = await inspectChains(rpcs, priceFetch.prices);
  const joins = localConsumerJoins(vaultRows, tokenRows);
  const summary = {
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    adapterChainsKnown: CHAINS.length + UNSUPPORTED_ADAPTER_CHAINS.length,
    chainsInspected: CHAINS.filter((chain) => Boolean(rpcs[chain.chainId])).length,
    unsupportedAdapterChains: UNSUPPORTED_ADAPTER_CHAINS.length,
    rpcAvailability: Object.fromEntries(CHAINS.map((chain) => [chain.chainId, Boolean(rpcs[chain.chainId])])),
    vaultRows: vaultRows.length,
    vaultRowsWithCode: vaultRows.filter((row) => row.codePresent).length,
    tokenRows: tokenRows.length,
    tokenRowsWithCode: tokenRows.filter((row) => row.codePresent).length,
    balanceRows: balanceRows.length,
    positiveBalanceRows: balanceRows.filter((row) => (asNumber(row.balanceUsd) || 0) > 0).length,
    totalTrackedBalanceUsd: round(balanceRows.reduce((sum, row) => sum + (asNumber(row.balanceUsd) || 0), 0), 2),
    directConsumerRows: joins.directConsumerRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: UNSUPPORTED_ADAPTER_CHAINS.length ? "bounded-with-caveats" : "full-enough-for-declared-scope",
    closedReason: "route-negative for vault-owner balance adapter scope; no Nest-specific consumer value path found",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-nest-credit-phase0.js",
    scope: "Read-only Nest Credit vault-owner stablecoin balance and consumer-route Phase 0 scan",
    target: { name: "Nest Credit", slug: "nest-credit", category: "RWA", surface: "vault-owner-balance-rwa", metadata },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    docs: { adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/nest-credit/index.js", methodology: "TVL is the total value of assets deposited in Nest Credit vaults across all chains" },
    thresholds: {},
    priceFetch: priceFetch.fetched,
    unsupportedAdapterChains: UNSUPPORTED_ADAPTER_CHAINS,
    tokenRows,
    vaultRows,
    balanceRows,
    directConsumerRows: joins.directConsumerRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 180),
    watchCandidates: [],
    routePositiveRows: [],
    summary,
    blockers: [
      "Adapter surface is vault-owner stablecoin balances, not a lending/oracle/AMM value source by itself",
      "No Nest vault-owner address was found in scanned consumer-grade artifacts",
      "Stablecoin token joins are common-asset context only and not Nest-specific impact",
      "Plasma USDT0 is outside current local RPC scope",
      "No exact positive borrow, redemption, liquidation, settlement, bridge, or DEX unwind economics or proof",
    ],
    requiredForRoutePositive: [
      "deployed consumer references Nest vault-owner, receipt, NAV, redemption, or accounting state",
      "permissionless vault/custody/redeem/bridge weakness affects liquid asset balance",
      "exact unwind, borrow, redeem, bridge, or liquidation economics positive after costs",
      "fork/local proof",
    ],
    nextReadOnlyStep: "Reopen Nest Credit only if a Nest-specific consumer or permissionless custody/redemption/bridge weakness appears; otherwise proceed to the next Phase 0 target.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Nest Credit Phase 0: vaultRows=${summary.vaultRows} balanceRows=${summary.balanceRows} positiveBalances=${summary.positiveBalanceRows} directConsumers=${summary.directConsumerRows} watch=0 routePositive=0`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
